import 'reflect-metadata';
import { DatabaseService } from '../database/database.service.js';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { ownedRabbit } from '../messaging/ownership.js';
import { ownedQdrant } from '../vector/ownership.js';
import { JobIndexVector } from '../vector/job-index.vector.js';
import type { EmbeddingExecutor } from '../../modules/embeddings/embedding-executor.js';
import { DevelopmentIdentity } from '../../modules/identity/identity.module.js';
import { createJobIndexDelivery } from './index-runtime.js';
import { TaskConsumer } from '../consumer/task.consumer.js';
import { QuarantineStore } from '../consumer/quarantine.store.js';
import { taskTopology } from '../messaging/task-topology.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { ReconciliationStore } from '../reconciliation/reconciliation.store.js';
import { reconciliationConfigSchema } from '../reconciliation/config.js';
import { OutboxPublisher } from '../outbox/outbox.publisher.js';
import { OutboxStore } from '../outbox/outbox.store.js';
import { outboxConfigSchema } from '../outbox/config.js';
import { ConfirmedTaskPublisher } from '../messaging/confirmed-publisher.js';

export async function runIndexWorker(mode: 'consume' | 'reconcile-once' | 'reconcile-watch', embedding: EmbeddingExecutor) {
let database: DatabaseService | undefined;
const abort = new AbortController(), stop = () => abort.abort();
try {
  const config = loadInfrastructureConfig(process.env);
  await ownedPostgres(); await ownedRabbit(); await ownedQdrant();
  database = new DatabaseService(config); const identity = new DevelopmentIdentity();
  const runtime = createJobIndexDelivery(database, identity, embedding, new JobIndexVector({ url: config.qdrantUrl, apiKey: config.qdrantApiKey }, ownedQdrant));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (mode === 'consume') {
    const result = await new TaskConsumer(config.rabbitmqUrl, taskTopology(), runtime.delivery, new QuarantineStore(database, identity))
      .run('job-index', { windowMs: 600_000, maxMessages: 10 }, abort.signal);
    console.log(JSON.stringify({ code: 'INDEX_CONSUMER_FINISHED', ...result }));
    if (!['limit', 'deadline', 'stopped'].includes(result.reason) || result.received !== result.acknowledged) process.exitCode = 1;
  } else {
    const delivery = outboxConfigSchema.parse({});
    const tasks: Pick<typeof runtime.store, 'reconcile'> = { reconcile: (owner, type, id, policy) =>
      runtime.store.reconcile(owner, type, id, policy, type === 'job-index' ? 'job-index' : 'synthetic', type === 'job-index' ? embedding.embeddingVersion : undefined) };
    const service = new ReconciliationService(new ReconciliationStore(database), tasks,
      new OutboxPublisher(new OutboxStore(database, delivery), new ConfirmedTaskPublisher(config.rabbitmqUrl, taskTopology(), delivery.publishTimeoutMs), identity, delivery),
      identity, reconciliationConfigSchema.parse({}));
    const report = (summary: Awaited<ReturnType<ReconciliationService['runOnce']>>) => console.log(JSON.stringify({ code: 'INDEX_RECONCILIATION', ...summary }));
    if (mode === 'reconcile-watch') await service.watch(abort.signal, report);
    else {
      const summary = await service.runOnce(abort.signal); report(summary);
      if (summary.stopped || summary.tasks.some(item => ['error', 'delivery-failed', 'lock-held'].includes(item))
        || summary.publications.some(item => !['published', 'idle'].includes(item)) || (summary.outbox?.failed ?? 0) > 0) process.exitCode = 1;
    }
  }
} finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); abort.abort(); await database?.onModuleDestroy(); }
}
