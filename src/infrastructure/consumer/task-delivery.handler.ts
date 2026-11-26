import { requestHash } from '../../modules/tasks/request-hash.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import type { TaskDispatch, UsageReservation } from '../../contracts/tasks.js';
import { syntheticCompletionSchema, ExecutionLeaseLostError } from './contracts.js';
import { TaskFailure, classifyTaskFailure } from './failure.js';
import type { ConsumerConfig } from './config.js';
import type { ExecutionClaim, SyntheticCompletion } from './contracts.js';
import type { TaskExecutionStore } from './task-execution.store.js';

export interface SyntheticTaskHandler {
  execute(claim: ExecutionClaim, signal: AbortSignal, budget: { reserve: (usage: UsageReservation) => Promise<void> }): Promise<SyntheticCompletion>;
}

export class SyntheticCompletionHandler implements SyntheticTaskHandler {
  execute(claim: ExecutionClaim, signal: AbortSignal): Promise<SyntheticCompletion> {
    signal.throwIfAborted();
    return Promise.resolve({ schemaVersion: 1, kind: 'synthetic', inputHash: requestHash(claim.snapshot), completedUnits: 1 });
  }
}

export class TaskDeliveryHandler {
  constructor(private readonly store: Pick<TaskExecutionStore, 'claim' | 'heartbeat' | 'complete' | 'fail' | 'reserveUsage'>,
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
    if (remaining <= 0) { await this.store.fail(claim, new TaskFailure('DEADLINE_EXCEEDED')); return 'ack'; }
    const stop = () => abort.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; stop(); }, remaining);
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
      let output: SyntheticCompletion | undefined, failure: TaskFailure | undefined, budgetInfrastructureError: unknown;
      try {
        output = syntheticCompletionSchema.parse(await Promise.race([this.handler.execute(claim, abort.signal, {
          reserve: async usage => {
            abort.signal.throwIfAborted();
            try { await this.store.reserveUsage(claim, usage); }
            catch (error) { if (!(error instanceof TaskFailure)) budgetInfrastructureError = error; throw error; }
            abort.signal.throwIfAborted();
          },
        }), interrupted]));
        if (output.inputHash !== requestHash(claim.snapshot)) throw new TaskFailure('OUTPUT_INVALID');
      } catch (error) {
        if (budgetInfrastructureError) throw budgetInfrastructureError;
        if (signal.aborted || heartbeatFailure || error instanceof ExecutionLeaseLostError) throw error;
        failure = timedOut ? new TaskFailure('DEADLINE_EXCEEDED') : classifyTaskFailure(error);
      }
      finished = true; clearTimeout(timer); await heartbeat;
      if (heartbeatFailure) throw heartbeatFailure;
      signal.throwIfAborted();
      if (timedOut) failure = new TaskFailure('DEADLINE_EXCEEDED');
      if (failure) await this.store.fail(claim, failure);
      else { abort.signal.throwIfAborted(); await this.store.complete(claim, output); }
      signal.throwIfAborted();
      return 'ack';
    } finally {
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      signal.removeEventListener('abort', stop); removeAbort(); stop();
      await heartbeat; // heartbeat DB work is bounded; no detached lease extension after completion
    }
  }
}
