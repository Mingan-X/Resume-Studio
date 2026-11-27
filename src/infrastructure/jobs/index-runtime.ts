import type { DatabaseService } from '../database/database.service.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import type { EmbeddingExecutor } from '../../modules/embeddings/embedding-executor.js';
import type { JobIndexVector } from '../vector/job-index.vector.js';
import { JobRepository } from './job.repository.js';
import { JobIndexHandler } from '../../modules/recall/job-index.handler.js';
import { TaskExecutionStore } from '../consumer/task-execution.store.js';
import { TaskDeliveryHandler } from '../consumer/task-delivery.handler.js';
import { PostgresExecutionLock } from '../consumer/task-execution.lock.js';
import { consumerConfigSchema } from '../consumer/config.js';
import type { ReconciliationConfig } from '../reconciliation/config.js';

// Explicit composition boundary. Production callers must supply the configured real adapter;
// tests opt into a synthetic port on their own fresh owner/collection, never a default fallback.
export function createJobIndexDelivery(database: DatabaseService, identity: IdentityPort,
  embedding: EmbeddingExecutor, vector: JobIndexVector, options: { allowSynthetic?: boolean } = {}) {
  const config = consumerConfigSchema.parse({}), store = new TaskExecutionStore(database, config);
  const executor = new JobIndexHandler(new JobRepository(database), embedding, vector, options);
  return { store, executor, delivery: new TaskDeliveryHandler(store, identity, executor, config, new PostgresExecutionLock(database.pool)),
    reconcile: async (taskId: string, policy: ReconciliationConfig) => store.reconcile(await identity.getOwnerId(), 'job-index', taskId, policy, 'job-index', embedding.embeddingVersion) };
}
