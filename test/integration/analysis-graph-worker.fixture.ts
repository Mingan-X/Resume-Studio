import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { loadCheckpointConfig } from '../../src/infrastructure/checkpoint/config.js';
import { createCheckpointPool } from '../../src/infrastructure/checkpoint/store.js';
import { AnalysisArtifactRepository } from '../../src/infrastructure/tasks/analysis-artifact.repository.js';
import { AnalysisGraph } from '../../src/modules/analysis/analysis-graph.js';
import type { AnalysisGraphNodes } from '../../src/modules/analysis/analysis-graph.js';
import { analysisNodeSchema } from '../../src/contracts/analysis-graph.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { fileURLToPath } from 'node:url';
import { safeFailure } from '../support/safe-failure.js';

async function run() {
  const ownerId = z.uuid().parse(process.env.S24_OWNER_ID), mode = z.enum(['pause','normal']).parse(process.env.S24_MODE);
  const message = taskDispatchSchema.parse(JSON.parse(process.env.S24_MESSAGE ?? '') as unknown);
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), config = consumerConfigSchema.parse({});
  const store = new TaskExecutionStore(database, config), abort = new AbortController();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const onMessage = (command: unknown) => { if (command === 'release') release(); if (command === 'abort') abort.abort(); };
  process.on('message', onMessage);
  try {
    const result = await new PostgresExecutionLock(database.pool).run(ownerId, 'analysis', message.taskId, abort.signal, async signal => {
      const result = await store.claim(ownerId, message, 'analysis', 'test-no-embedding-v1', 'test-no-model-v1');
      if (result.kind !== 'acquired') throw new Error('CLAIM_UNAVAILABLE');
      const claim = result.claim; process.send?.({ event: 'claimed', attemptId: claim.attemptId, fenceToken: claim.fenceToken.toString(),
        graph: claim.graph, startedAt: claim.startedAt.toISOString(), deadline: claim.deadline.toISOString() });
      let paused = false;
      class PauseSaver extends PostgresSaver {
        override async put(...args: Parameters<PostgresSaver['put']>) {
          const outputs = z.object({ PARSE: z.unknown().optional() }).passthrough().safeParse(args[1].channel_values.outputs);
          if (!paused && mode === 'pause' && outputs.success && outputs.data.PARSE) {
            paused = true; process.send?.({ event: 'paused' }); await gate;
          }
          return super.put(...args);
        }
      }
      const fixtureNode: AnalysisGraphNodes['LOAD'] = async () => ({ status: 'ok', artifactId: randomUUID() });
      const nodes: AnalysisGraphNodes = { LOAD: fixtureNode, PARSE: fixtureNode, EXTRACT: fixtureNode, VALIDATE: fixtureNode,
        PROFILE: fixtureNode, RECALL: fixtureNode, SNAP: fixtureNode, MATCH: fixtureNode, SCORE: fixtureNode, RANK: fixtureNode, JOIN: fixtureNode, FINALIZE: fixtureNode };
      for (const node of analysisNodeSchema.options) nodes[node] = async () => {
        process.send?.({ event: 'node', node }); return { status: 'ok', artifactId: randomUUID() };
      };
      const graph = new AnalysisGraph(loadCheckpointConfig(process.env), new AnalysisArtifactRepository(database), nodes, c => {
        const pool = createCheckpointPool(c.databaseUrl, c.poolMax), saver = new PauseSaver(pool, undefined, { schema: c.schema });
        return { pool, saver, close: () => pool.end() };
      });
      const output = await graph.execute(claim, signal, { reserve: usage => store.reserveUsage(claim, usage) });
      await store.markExecutionStopped(claim);
      process.send?.({ event: 'finished', nodes: Object.keys(output.outputs).length });
      return true;
    });
    if (result === null) throw new Error('TEST_EXECUTION_LOCK_HELD');
  } finally { process.off('message', onMessage); await database.onModuleDestroy(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await run(); } catch (error) {
    await new Promise<void>(resolve => { if (process.send) process.send({ event: 'failed', ...safeFailure(error) }, undefined, undefined, () => resolve()); else resolve(); });
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
}
