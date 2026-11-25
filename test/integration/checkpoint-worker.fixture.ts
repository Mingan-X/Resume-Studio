// Test-only graph and crash barriers. Never imported by the API or production Worker.
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadCheckpointConfig } from '../../src/infrastructure/checkpoint/config.js';
import { createCheckpointPool } from '../../src/infrastructure/checkpoint/store.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';

export const syntheticInputSchema = z.object({ inputId: z.uuid(), value: z.int(), step: z.literal('input') }).strict();
export const syntheticOutputSchema = z.object({ inputId: z.uuid(), value: z.int(), step: z.enum(['input', 'first', 'second']) }).strict();
export const workerMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('waiting'), barrier: z.enum(['before-checkpoint', 'second-node']) }).strict(),
  z.object({ event: z.literal('completed'), mode: z.enum(['resume', 'restart']), result: syntheticOutputSchema }).strict(),
]);

async function pause(): Promise<void> {
  // Parent forcibly kills this process; a live handle keeps the barrier deterministic.
  setInterval(() => {}, 1_000);
  await new Promise<void>(() => {});
}

class BeforeFirstWriteSaver extends PostgresSaver {
  override async put(...args: Parameters<PostgresSaver['put']>): ReturnType<PostgresSaver['put']> {
    process.send?.({ event: 'waiting', barrier: 'before-checkpoint' });
    await pause();
    return super.put(...args);
  }
}

async function run(): Promise<void> {
  const threadId = z.uuid().parse(process.argv[2]);
  const barrier = z.enum(['before-checkpoint', 'second-node', 'none']).parse(process.argv[3]);
  const config = loadCheckpointConfig(process.env);
  const pool = createCheckpointPool(config.databaseUrl, config.poolMax);
  const business = createCheckpointPool(loadInfrastructureConfig(process.env).databaseUrl, 1);
  try {
    const Saver = barrier === 'before-checkpoint' ? BeforeFirstWriteSaver : PostgresSaver;
    const saver = new Saver(pool, undefined, { schema: config.schema });
    const state = Annotation.Root({
      inputId: Annotation<string>(), value: Annotation<number>(),
      step: Annotation<'input' | 'first' | 'second'>(),
    });
    const record = async (node: string) => {
      await business.query('INSERT INTO s12_diagnostic_record (id, run_id, key, value) VALUES ($1, $2, $3, $4)',
        [randomUUID(), threadId, `s13.node.${threadId}.${node}.${randomUUID()}`, node]);
    };
    const graph = new StateGraph(state)
      .addNode('first', async value => {
        // No synthetic side effects while the first checkpoint write is deliberately held.
        if (barrier === 'before-checkpoint') await pause();
        const input = syntheticOutputSchema.parse(value);
        await record('first');
        return { value: input.value + 2, step: 'first' as const };
      })
      .addNode('second', async value => {
        if (barrier === 'second-node') {
          process.send?.({ event: 'waiting', barrier });
          await pause();
        }
        const input = syntheticOutputSchema.parse(value);
        await record('second');
        return { value: input.value * 3, step: 'second' as const };
      })
      .addEdge(START, 'first').addEdge('first', 'second').addEdge('second', END)
      .compile({ checkpointer: saver });
    const invocation = { configurable: { thread_id: threadId }, durability: 'sync' as const,
      recursionLimit: 10, signal: AbortSignal.timeout(20_000) };
    const checkpoint = await saver.getTuple(invocation);
    const inputRows = await business.query('SELECT value FROM s12_diagnostic_record WHERE id = $1::uuid AND run_id = $1::text', [threadId]);
    const saved = z.array(z.object({ value: z.string() })).length(1).parse(inputRows.rows);
    const input = syntheticInputSchema.parse(JSON.parse(saved[0]?.value ?? '') as unknown);
    if (input.inputId !== threadId) throw new Error('Input identity mismatch.');
    // Resume requires null, not the initial input; without any checkpoint use the separately persisted input.
    const output = await graph.invoke(checkpoint ? null : input, invocation);
    process.send?.({ event: 'completed', mode: checkpoint ? 'resume' : 'restart', result: syntheticOutputSchema.parse(output) });
  } finally {
    await Promise.all([business.end(), pool.end()]);
    if (process.connected) process.disconnect();
  }
}

// Exported schemas are also consumed by the parent; only execute when forked as the entrypoint.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await run(); }
  catch {
    process.stderr.write('SYNTHETIC_CHECKPOINT_WORKER_FAILED\n');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
