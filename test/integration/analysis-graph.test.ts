import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { createCheckpointStore } from '../../src/infrastructure/checkpoint/store.js';
import { loadCheckpointConfig } from '../../src/infrastructure/checkpoint/config.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import { AnalysisArtifactRepository } from '../../src/infrastructure/tasks/analysis-artifact.repository.js';
import { confirmWorkerExit } from '../../src/infrastructure/consumer/worker-exit.js';
import type { ExecutionClaim } from '../../src/infrastructure/consumer/contracts.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { seedRealAnalysis, cleanRealAnalysis } from '../support/real-analysis.js';
import { safeFailureSchema } from '../support/safe-failure.js';

const eventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('claimed'), attemptId: z.uuid(), fenceToken: z.string(), startedAt: z.iso.datetime(), deadline: z.iso.datetime(),
    graph: z.object({ threadId: z.uuid(), generation: z.int().positive() }) }),
  z.object({ event: z.literal('paused') }), z.object({ event: z.literal('node'), node: z.string() }),
  z.object({ event: z.literal('finished'), nodes: z.int() }), safeFailureSchema.extend({ event: z.literal('failed') }),
]);
type WorkerEvent = z.infer<typeof eventSchema>;

await test('S2.4 business graph survives worker death, validates artifacts and fences versions/branches/cancellation', { timeout: 180_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const checkpoints = createCheckpointStore(loadCheckpointConfig(process.env)), store = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
  const owners: string[] = [], threads = new Set<string>();
  const workers: { child: ChildProcess; exited: Promise<unknown[]> }[] = [];
  mkdirSync('data/s24-graph-runs', { recursive: true }); const manifest = `data/s24-graph-runs/${randomUUID()}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ owners, threads: [...threads], cleaned })); save();
  t.after(async () => {
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGKILL'); await worker.exited; }
    try {
      await ownedPostgres();
      for (const ownerId of owners) for (const row of await db.analysisTask.findMany({ where: { ownerId } })) threads.add(row.activeGraphThreadId);
      save(); for (const thread of threads) await checkpoints.saver.deleteThread(thread);
      for (const ownerId of owners) await cleanRealAnalysis(database, ownerId); save(true);
    } finally { await checkpoints.close(); await database.onModuleDestroy(); }
  });
  const spawn = (ownerId: string, message: z.infer<typeof taskDispatchSchema>, mode: 'pause' | 'normal') => {
    const env = { ...process.env, S24_OWNER_ID: ownerId, S24_MESSAGE: JSON.stringify(message), S24_MODE: mode };
    for (const key of ['CHECKPOINT_SETUP_URL','POSTGRES_ADMIN_PASSWORD','LANGSMITH_API_KEY','LANGCHAIN_API_KEY','NODE_OPTIONS']) delete env[key as keyof typeof env];
    const child = fork(new URL('./analysis-graph-worker.fixture.js', import.meta.url), [], { env, silent: true, execArgv: [] });
    child.stdout?.resume(); child.stderr?.resume(); const events: WorkerEvent[] = []; let invalid = false;
    child.on('message', raw => { const parsed = eventSchema.safeParse(raw); if (!parsed.success) { invalid = true; return; }
      events.push(parsed.data); if (parsed.data.event === 'claimed') { threads.add(parsed.data.graph.threadId); save(); } });
    const exited = once(child, 'exit'); workers.push({ child, exited });
    const event = async <E extends WorkerEvent['event']>(name: E): Promise<Extract<WorkerEvent, { event: E }>> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        assert.equal(invalid, false);
        const found = events.find((item): item is Extract<WorkerEvent, { event: E }> => item.event === name); if (found) return found;
        const failure = events.find(item => item.event === 'failed');
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`WORKER_ENDED_${name}:${JSON.stringify({ failure, exitCode: child.exitCode, signalCode: child.signalCode })}`);
        await delay(20);
      }
      throw new Error(`WORKER_TIMEOUT_${name}`);
    };
    return { child, exited, event, events };
  };
  for (const confirmed of [true, false]) await t.test(confirmed ? 'confirmed exit resumes same thread without replaying committed nodes' : 'unknown stopped marker switches thread and reuses business artifacts', async () => {
    const ownerId = randomUUID(); owners.push(ownerId); save();
    const seeded = await seedRealAnalysis(database, ownerId); threads.add(seeded.taskId); save();
    assert.equal((await store.claim(ownerId, seeded.message, 'analysis', seeded.snapshot.embeddingVersion, 'wrong-model')).kind, 'deferred');
    const old = spawn(ownerId, seeded.message, 'pause'), info = await old.event('claimed'); await old.event('paused');
    const oldClaim: ExecutionClaim = { ownerId, message: seeded.message, consumerName: 'analysis.worker.v1', snapshot: seeded.snapshot,
      attemptId: info.attemptId, fenceToken: BigInt(info.fenceToken), startedAt: new Date(info.startedAt), deadline: new Date(info.deadline), graph: info.graph };
    const saved = await db.nodeArtifact.findMany({ where: { ownerId }, orderBy: { node: 'asc' } });
    assert.equal(saved.length, 2);
    old.child.kill('SIGKILL'); await old.exited;
    if (confirmed) await confirmWorkerExit(old.child, oldClaim, store);
    await db.$executeRaw`UPDATE analysis_task SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=${ownerId}::uuid AND id=${seeded.taskId}::uuid`;
    assert.equal(await store.reconcile(ownerId, 'analysis', seeded.taskId, reconciliationConfigSchema.parse({}), 'analysis',
      seeded.snapshot.embeddingVersion, seeded.snapshot.modelConfigVersion), 'recovered');
    const current = await db.analysisTask.findUniqueOrThrow({ where: { id: seeded.taskId } });
    const outbox = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: seeded.taskId,
      payload: { path: ['dispatchGeneration'], equals: current.generation } } });
    const message = taskDispatchSchema.parse(outbox.payload), fresh = spawn(ownerId, message, 'normal'), next = await fresh.event('claimed');
    assert.equal(next.graph.threadId === info.graph.threadId, confirmed); assert.equal(next.graph.generation, info.graph.generation + (confirmed ? 0 : 1));
    assert.equal((await fresh.event('finished')).nodes, 12); assert.equal((await fresh.exited)[0], 0);
    assert.ok(!fresh.events.some(event => event.event === 'node' && ['LOAD', 'PARSE'].includes(event.node)));
    assert.equal(await db.nodeArtifact.count({ where: { ownerId } }), 12);
    for (const prior of saved) assert.deepEqual(await db.nodeArtifact.findUnique({ where: { id: prior.id } }), prior);
    const newClaim: ExecutionClaim = { ...oldClaim, message, attemptId: next.attemptId, fenceToken: BigInt(next.fenceToken),
      startedAt: new Date(next.startedAt), deadline: new Date(next.deadline), graph: next.graph };
    const artifacts = new AnalysisArtifactRepository(database), identity = { node: 'MATCH', branchKey: `job:${randomUUID()}`,
      inputHash: 'a'.repeat(64), componentVersion: 'test-graph-v1', schemaVersion: 1,
      promptVersion: seeded.snapshot.promptVersion, modelConfigVersion: seeded.snapshot.modelConfigVersion };
    await assert.rejects(artifacts.node(oldClaim, identity, { status: 'ok', artifactId: randomUUID() }), /LEASE_LOST/);
    const one = await artifacts.node(newClaim, identity, { status: 'ok', artifactId: randomUUID() }); assert.ok(one);
    assert.deepEqual(await artifacts.node(newClaim, identity), one);
    const two = await artifacts.node(newClaim, { ...identity, branchKey: `job:${randomUUID()}` }, { status: 'ok', artifactId: randomUUID() });
    assert.notEqual(one.id, two?.id);
    await assert.rejects(artifacts.node(newClaim, identity, { status: 'failed', code: 'OUTPUT_INVALID' }), /ARTIFACT_CONFLICT/);
    await assert.rejects(artifacts.node(newClaim, { ...identity, promptVersion: 'changed' }), /VERSION_MISMATCH/);
    await assert.rejects(db.nodeArtifact.update({ where: { id: one.id }, data: { validatedOutput: {} } }));
    await assert.rejects(store.reserveUsage({ ...newClaim, graph: { ...next.graph, threadId: randomUUID() } }, { modelCalls: 1, tokens: 1, costMicros: 1 }), /LEASE_LOST/);
    await db.analysisTask.update({ where: { id: seeded.taskId }, data: { cancelRequested: true } });
    await assert.rejects(artifacts.node(newClaim, identity), /LEASE_LOST/);
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: seeded.taskId } })).status, 'RUNNING'); // Fixture never claims a business success.
  });
});
