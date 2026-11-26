import 'reflect-metadata';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadCheckpointConfig } from '../../src/infrastructure/checkpoint/config.js';
import { createCheckpointPool } from '../../src/infrastructure/checkpoint/store.js';
import { CheckpointTaskHandler } from '../../src/infrastructure/checkpoint/task-handler.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { syntheticCompletionSchema } from '../../src/infrastructure/consumer/contracts.js';
import type { ExecutionClaim } from '../../src/infrastructure/consumer/contracts.js';
import { requestHash } from '../../src/modules/tasks/request-hash.js';

export const claimIdentitySchema = z.object({ ownerId: z.uuid(), attemptId: z.uuid(), fenceToken: z.string().regex(/^\d+$/),
  startedAt: z.iso.datetime(), deadline: z.iso.datetime(), graph: z.object({ threadId: z.uuid(), generation: z.int().positive() }).optional() });
export const fenceWorkerMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('claimed'), identity: claimIdentitySchema }),
  z.object({ event: z.literal('paused'), location: z.enum(['checkpoint-write','before-invoke','index-write']), threadId: z.uuid().optional() }),
  z.object({ event: z.literal('late-checkpoint'), threadId: z.uuid() }),
  z.object({ event: z.literal('stale-writes'), artifactRejected: z.boolean(), terminalRejected: z.boolean(), indexRejected: z.boolean() }),
  z.object({ event: z.literal('finished'), result: z.enum(['ack','deferred','interrupted']) }),
  z.object({ event: z.literal('failed'), phase: z.enum(['startup', 'delivery']),
    category: z.enum(['database', 'lease', 'schema', 'other']), code: z.string().regex(/^(P\d{4}|[0-9A-Z]{5}|UNKNOWN)$/) }),
]);
const send = (message: z.infer<typeof fenceWorkerMessageSchema>) => process.send?.(fenceWorkerMessageSchema.parse(message));
function safeFailure(error: unknown, phase: 'startup' | 'delivery') {
  const metadata = z.object({ code: z.string().optional(), name: z.string().optional() }).passthrough().safeParse(error);
  const name = metadata.success ? metadata.data.name ?? '' : '';
  const rawCode = metadata.success ? metadata.data.code : undefined;
  const code = rawCode && /^(P\d{4}|[0-9A-Z]{5})$/.test(rawCode) ? rawCode : 'UNKNOWN';
  const category = name.includes('Prisma') || name === 'DatabaseError' ? 'database'
    : error instanceof Error && error.message === 'TASK_EXECUTION_LEASE_LOST' ? 'lease'
    : name === 'ZodError' ? 'schema' : 'other';
  send({ event: 'failed', phase, category, code });
}

async function run() {
  const ownerId = z.uuid().parse(process.env.S17_OWNER_ID), message = taskDispatchSchema.parse(JSON.parse(process.env.S17_MESSAGE ?? '') as unknown);
  const mode = z.enum(['late-checkpoint','before-invoke','normal','late-index','normal-index']).parse(process.env.S17_MODE);
  const database = new DatabaseService(loadInfrastructureConfig(process.env));
  const label = z.string().regex(/^s17-[a-f0-9-]+$/).parse(process.env.S17_LABEL);
  database.pool.options.application_name = label;
  const tasks = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
  const checkpoint = loadCheckpointConfig(process.env), abort = new AbortController();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const commands = (input: unknown) => { if (input === 'release') release(); if (input === 'abort') abort.abort(); };
  process.on('message', commands);
  let current: ExecutionClaim | undefined, barrierUsed = false;
  const identity = (claim: ExecutionClaim) => ({ ownerId: claim.ownerId, attemptId: claim.attemptId,
    fenceToken: claim.fenceToken.toString(), startedAt: claim.startedAt.toISOString(), deadline: claim.deadline.toISOString(),
    ...(claim.graph ? { graph: claim.graph } : {}) });
  class LateSaver extends PostgresSaver {
    override async put(...args: Parameters<PostgresSaver['put']>): ReturnType<PostgresSaver['put']> {
      const step = args[1].channel_values.step;
      if (!barrierUsed && mode === 'late-checkpoint' && step === 'first') {
        barrierUsed = true; send({ event: 'paused', location: 'checkpoint-write', threadId: current!.graph!.threadId });
        await gate;
        const result = await super.put(...args); // actual official saver write, after the new execution has finished
        send({ event: 'late-checkpoint', threadId: current!.graph!.threadId });
        return result;
      }
      return super.put(...args);
    }
  }
  const graph = new CheckpointTaskHandler(checkpoint, tasks, config => {
    const pool = createCheckpointPool(config.databaseUrl, config.poolMax);
    const saver = new LateSaver(pool, undefined, { schema: config.schema });
    return { pool, saver, close: () => pool.end() };
  });
  const handler = new TaskDeliveryHandler(tasks, { getOwnerId: () => Promise.resolve(ownerId) }, { execute: async (claim, signal) => {
    current = claim; send({ event: 'claimed', identity: identity(claim) });
    if (mode === 'before-invoke') { send({ event: 'paused', location: 'before-invoke', threadId: claim.graph!.threadId }); await gate; }
    if (mode === 'late-index' || mode === 'normal-index') {
      if (mode === 'late-index') { send({ event: 'paused', location: 'index-write' }); await gate; }
      const target = z.uuid().parse(process.env.S17_TARGET_ID);
      await tasks.publishSyntheticIndex(claim, target);
      await tasks.nodeArtifact(claim,'index',{schemaVersion:1,kind:'synthetic',node:'index',inputHash:requestHash(claim.snapshot),value:1});
      return new SyntheticCompletionHandler().execute(claim, signal);
    }
    return graph.execute(claim, signal);
  } }, consumerConfigSchema.parse({}), new PostgresExecutionLock(database.pool));
  try {
    let result: 'ack' | 'deferred' | 'interrupted';
    try { result = await handler.handle(message, abort.signal); }
    catch (error) { if (!current) safeFailure(error, 'delivery'); result = 'interrupted'; }
    // Independently try both stale business writes; do not mistake AbortSignal compliance for fencing.
    if (current && ['late-checkpoint','late-index'].includes(mode)) {
      const claim = current; let artifactRejected = false, terminalRejected = false, indexRejected = false;
      try { await tasks.nodeArtifact(claim, mode === 'late-index' ? 'index' : 'second', {
        schemaVersion: 1, kind: 'synthetic', node: mode === 'late-index' ? 'index' : 'second', inputHash: requestHash(claim.snapshot), value: 999 }); }
      catch { artifactRejected = true; }
      try { await tasks.complete(claim, syntheticCompletionSchema.parse({ schemaVersion: 1, kind: 'synthetic', inputHash: requestHash(claim.snapshot), completedUnits: 1 })); }
      catch { terminalRejected = true; }
      if (mode === 'late-index') {
        try { await tasks.publishSyntheticIndex(claim, z.uuid().parse(process.env.S17_TARGET_ID)); } catch { indexRejected = true; }
      }
      send({ event: 'stale-writes', artifactRejected, terminalRejected, indexRejected });
    }
    send({ event: 'finished', result });
  } finally { process.off('message', commands); await database.onModuleDestroy(); if (process.connected) process.disconnect(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await run(); } catch (error) { safeFailure(error, 'startup'); process.exitCode = 1; if (process.connected) process.disconnect(); }
}
