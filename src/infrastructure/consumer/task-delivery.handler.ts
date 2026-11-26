import { requestHash } from '../../modules/tasks/request-hash.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import type { TaskDispatch } from '../../contracts/tasks.js';
import type { ConsumerConfig } from './config.js';
import type { ExecutionClaim, SyntheticCompletion } from './contracts.js';
import type { TaskExecutionStore } from './task-execution.store.js';

export interface SyntheticTaskHandler {
  execute(claim: ExecutionClaim, signal: AbortSignal): Promise<SyntheticCompletion>;
}

export class SyntheticCompletionHandler implements SyntheticTaskHandler {
  execute(claim: ExecutionClaim, signal: AbortSignal): Promise<SyntheticCompletion> {
    signal.throwIfAborted();
    return Promise.resolve({ schemaVersion: 1, kind: 'synthetic', inputHash: requestHash(claim.snapshot), completedUnits: 1 });
  }
}

export class TaskDeliveryHandler {
  constructor(private readonly store: Pick<TaskExecutionStore, 'claim' | 'heartbeat' | 'complete'>,
    private readonly identity: IdentityPort, private readonly handler: SyntheticTaskHandler,
    private readonly config: ConsumerConfig) {}

  async handle(message: TaskDispatch, signal: AbortSignal): Promise<'ack' | 'deferred'> {
    signal.throwIfAborted();
    const result = await this.store.claim(await this.identity.getOwnerId(), message);
    signal.throwIfAborted();
    if (result.kind !== 'acquired') return result.kind;
    const { claim } = result;
    const abort = new AbortController();
    const remaining = claim.deadline.getTime() - Date.now();
    if (remaining <= 0) throw new Error('TASK_DEADLINE_EXCEEDED');
    const stop = () => abort.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const deadline = setTimeout(stop, remaining);
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: Promise<void> = Promise.resolve();
    let heartbeatFailure: unknown;
    let finished = false;
    const schedule = () => {
      if (finished || abort.signal.aborted) return;
      timer = setTimeout(() => {
        heartbeat = this.store.heartbeat(claim).catch(error => { heartbeatFailure = error; stop(); })
          .then(schedule);
      }, this.config.heartbeatMs);
    };
    schedule();
    let removeAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new Error('TASK_EXECUTION_INTERRUPTED'));
      abort.signal.addEventListener('abort', fail, { once: true });
      removeAbort = () => abort.signal.removeEventListener('abort', fail);
      if (abort.signal.aborted) fail();
    });
    try {
      const output = await Promise.race([this.handler.execute(claim, abort.signal), interrupted]);
      finished = true; clearTimeout(timer); await heartbeat;
      if (heartbeatFailure) throw heartbeatFailure;
      abort.signal.throwIfAborted();
      await this.store.complete(claim, output);
      abort.signal.throwIfAborted();
      return 'ack';
    } finally {
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      signal.removeEventListener('abort', stop); removeAbort(); stop();
      await heartbeat; // heartbeat DB work is bounded; no detached lease extension after completion
    }
  }
}
