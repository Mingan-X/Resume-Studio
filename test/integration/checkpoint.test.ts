import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createCheckpointPool, createCheckpointStore } from '../../src/infrastructure/checkpoint/store.js';
import { loadCheckpointConfig, loadCheckpointSetupUrl } from '../../src/infrastructure/checkpoint/config.js';
import { setupCheckpoint } from '../../src/infrastructure/checkpoint/admin.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { syntheticInputSchema, syntheticOutputSchema, workerMessageSchema } from './checkpoint-worker.fixture.js';

const config = loadCheckpointConfig(process.env);
const setupUrl = loadCheckpointSetupUrl(process.env);
const businessUrl = loadInfrastructureConfig(process.env).databaseUrl;

function startWorker(t: TestContext, threadId: string, barrier: 'before-checkpoint' | 'second-node' | 'none') {
  const env: NodeJS.ProcessEnv = { ...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' };
  for (const key of ['CHECKPOINT_SETUP_URL', 'POSTGRES_ADMIN_PASSWORD', 'POSTGRES_PASSWORD',
    'RABBITMQ_PASSWORD', 'LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY', 'NODE_OPTIONS']) delete env[key];
  const child = fork(fileURLToPath(new URL('./checkpoint-worker.fixture.js', import.meta.url)), [threadId, barrier], {
    env, silent: true, execArgv: [],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', code => resolve(code)); child.once('error', reject);
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const message = new Promise<z.infer<typeof workerMessageSchema>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic worker event timed out.')), 15_000);
    child.once('message', value => {
      clearTimeout(timer);
      const parsed = workerMessageSchema.safeParse(value);
      if (parsed.success) resolve(parsed.data); else reject(new Error('Invalid synthetic worker event.'));
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Synthetic worker exited before event: ${stderr}`)); });
  });
  return { child, exited, message };
}

await test('Official PostgreSQL Checkpointer setup, isolation and process recovery', { timeout: 100_000 }, async t => {
  await ownedPostgres();
  const store = createCheckpointStore(config);
  const business = createCheckpointPool(businessUrl, 3);
  t.after(async () => {
    await Promise.all([store.close(), business.end()]);
    assert.equal(store.pool.totalCount, 0);
    assert.equal(business.totalCount, 0);
  });

  await t.test('explicit setup is repeatable without duplicating tables or migrations', async () => {
    await setupCheckpoint(config, setupUrl);
    const before = await store.pool.query('SELECT v FROM langgraph.checkpoint_migrations ORDER BY v');
    assert.ok(before.rows.length > 0);
    await setupCheckpoint(config, setupUrl);
    assert.deepEqual((await store.pool.query('SELECT v FROM langgraph.checkpoint_migrations ORDER BY v')).rows, before.rows);
    const tables = await store.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'langgraph' ORDER BY tablename");
    assert.deepEqual(tables.rows.map(row => z.object({ tablename: z.string() }).parse(row).tablename),
      ['checkpoint_blobs', 'checkpoint_migrations', 'checkpoint_writes', 'checkpoints']);
  });

  await t.test('business and Checkpointer accounts cannot access each other; runtime cannot perform DDL', async () => {
    const businessToCheckpoint = new URL(businessUrl); businessToCheckpoint.pathname = '/resume_studio_checkpoint';
    const checkpointToBusiness = new URL(config.databaseUrl); checkpointToBusiness.pathname = '/resume_studio_s12_test';
    for (const url of [businessToCheckpoint, checkpointToBusiness]) {
      const pool = createCheckpointPool(url.toString(), 1);
      try { await assert.rejects(pool.query('SELECT 1'), { code: '42501' }); }
      finally { await pool.end(); }
    }
    await assert.rejects(store.pool.query('CREATE TABLE langgraph.forbidden (id integer)'), { code: '42501' });
    await assert.rejects(store.pool.query('UPDATE langgraph.checkpoint_migrations SET v = v WHERE false'), { code: '42501' });
    await assert.rejects(store.pool.query('CREATE SCHEMA forbidden'), { code: '42501' });
    await Promise.all(Array.from({ length: 8 }, () => store.pool.query('SELECT pg_sleep(0.02)')));
    assert.ok(store.pool.totalCount <= config.poolMax);
  });

  for (const barrier of ['second-node', 'before-checkpoint'] as const) {
    await t.test(`killed process at ${barrier} recovers without losing its persisted input`, async childTest => {
      const threadId = randomUUID();
      await ownedPostgres();
      assert.equal(await store.saver.getTuple({ configurable: { thread_id: threadId } }), undefined);
      const input = syntheticInputSchema.parse({ inputId: threadId, value: 7, step: 'input' });
      const workers: ReturnType<typeof startWorker>[] = [];
      try {
        await business.query('INSERT INTO s12_diagnostic_record (id, run_id, key, value) VALUES ($1::uuid,$1::text,$2,$3)',
          [threadId, `s13.input.${threadId}`, JSON.stringify(input)]);
        const stopped = startWorker(childTest, threadId, barrier);
        workers.push(stopped);
        assert.deepEqual(await stopped.message, { event: 'waiting', barrier });
        if (barrier === 'second-node') {
          // Observe a durable completed first node before killing; IPC alone is not persistence evidence.
          const deadline = Date.now() + 8_000;
          while (true) {
            const saved = await store.saver.getTuple({ configurable: { thread_id: threadId } });
            const state = syntheticOutputSchema.strip().safeParse(saved?.checkpoint.channel_values);
            if (state.success && state.data.step === 'first') break;
            assert.ok(Date.now() < deadline, 'First node checkpoint was not committed.');
            await delay(25);
          }
        } else assert.equal(await store.saver.getTuple({ configurable: { thread_id: threadId } }), undefined);
        assert.ok(stopped.child.kill('SIGKILL'));
        await stopped.exited; // Confirm the old execution is dead before reusing its thread.
        await setupCheckpoint(config, setupUrl); // setup must not erase the retained thread.
        const resumed = startWorker(childTest, threadId, 'none');
        workers.push(resumed);
        assert.deepEqual(await resumed.message, {
          event: 'completed', mode: barrier === 'second-node' ? 'resume' : 'restart',
          result: { inputId: threadId, value: 27, step: 'second' },
        });
        assert.equal(await resumed.exited, 0);
        const executions = await business.query(
          "SELECT value FROM s12_diagnostic_record WHERE run_id = $1 AND key LIKE 's13.node.%' ORDER BY value", [threadId]);
        assert.deepEqual(executions.rows, [{ value: 'first' }, { value: 'second' }]);
        const final = await store.saver.getTuple({ configurable: { thread_id: threadId } });
        assert.deepEqual(syntheticOutputSchema.strip().parse(final?.checkpoint.channel_values), { inputId: threadId, value: 27, step: 'second' });
      } finally {
        for (const worker of workers) {
          if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
          await worker.exited;
        }
        await ownedPostgres();
        await store.saver.deleteThread(threadId);
        await business.query('DELETE FROM s12_diagnostic_record WHERE run_id = $1', [threadId]);
      }
    });
  }
});
