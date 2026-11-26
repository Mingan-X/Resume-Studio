import { taskDispatchSchema } from '../../contracts/tasks.js';
import type { TaskDispatch } from '../../contracts/tasks.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import { PublishError } from '../messaging/rabbitmq.service.js';
import type { TaskPublisherPort } from '../messaging/confirmed-publisher.js';
import { retryDelay } from './config.js';
import type { OutboxConfig } from './config.js';
import type { OutboxStore } from './outbox.store.js';
import type { OutboxClaim } from './outbox.store.js';

export function dispatchFromClaim(claim: OutboxClaim): TaskDispatch {
  const message = taskDispatchSchema.parse(claim.payload);
  const analysis = message.taskType === 'analysis';
  if (claim.payloadVersion !== message.schemaVersion || claim.eventId !== message.messageId
    || claim.aggregateId !== message.taskId
    || claim.aggregateType !== (analysis ? 'AnalysisTask' : 'JobIndexTask')
    || claim.eventType !== (analysis ? 'analysis.requested.v1' : 'job.index.requested.v1')) {
    throw new Error('Invalid outbox task reference.');
  }
  return message;
}

export class OutboxPublisher {
  constructor(private readonly store: Pick<OutboxStore, 'claim' | 'markPublished' | 'markFailed'>, private readonly transport: TaskPublisherPort,
    private readonly identity: IdentityPort, private readonly config: OutboxConfig) {}

  async runOnce(signal?: AbortSignal) {
    if (signal?.aborted) return 'stopped';
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    const claim = await this.store.claim(ownerId);
    if (!claim) return 'idle';
    if (claim.failedAt) return 'exhausted';
    let message: TaskDispatch;
    try { message = dispatchFromClaim(claim); }
    catch {
      return await this.store.markFailed(claim, 'INVALID_EVENT', 0, true) ? 'invalid' : 'lease-lost';
    }
    // Enforce remaining event lifetime as well as the caller's batch budget.
    const remainingMs = this.config.maxAgeMs - (Date.now() - claim.createdAt.getTime());
    if (remainingMs <= 0) {
      return await this.store.markFailed(claim, 'CONFIRM_TIMEOUT', 0, true) ? 'exhausted' : 'lease-lost';
    }
    const deadline = AbortSignal.timeout(remainingMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try { await this.transport.publish(message, combined); }
    catch (error) {
      if (!(error instanceof PublishError)) throw error; // programming errors stay visible; lease is recoverable
      return await this.store.markFailed(claim, error.code, retryDelay(this.config, claim.publishAttempts), false)
        ? 'failed' : 'lease-lost';
    }
    // A DB failure here must escape with the lease intact; the already-confirmed message may be replayed.
    return await this.store.markPublished(claim) ? 'published' : 'lease-lost';
  }

  async runBatch(signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(this.config.batchTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const results: string[] = [];
    for (let index = 0; index < this.config.batchLimit && !combined.aborted; index++) {
      const result = await this.runOnce(combined);
      results.push(result);
      if (result === 'idle' || result === 'stopped') break;
    }
    if (combined.aborted && results.at(-1) !== 'stopped') results.push('stopped');
    return results;
  }
}
