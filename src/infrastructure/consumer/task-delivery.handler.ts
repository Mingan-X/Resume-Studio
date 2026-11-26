import { requestHash } from '../../modules/tasks/request-hash.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import { taskDispatchSchema } from '../../contracts/tasks.js';
import type { TaskDispatch, UsageReservation } from '../../contracts/tasks.js';
import { syntheticCompletionSchema, ExecutionLeaseLostError, ExecutionUnsettledError } from './contracts.js';
import { TaskFailure, classifyTaskFailure } from './failure.js';
import type { ConsumerConfig } from './config.js';
import type { ExecutionClaim, SyntheticCompletion } from './contracts.js';
import type { TaskExecutionStore } from './task-execution.store.js';
import type { ExecutionLock } from './task-execution.lock.js';

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
  constructor(private readonly store: Pick<TaskExecutionStore, 'claim' | 'heartbeat' | 'complete' | 'fail' | 'reserveUsage' | 'markExecutionStopped'>,
    private readonly identity: IdentityPort, private readonly handler: SyntheticTaskHandler,
    private readonly config: ConsumerConfig, private readonly locks: ExecutionLock) {}

  async handle(message: TaskDispatch, signal: AbortSignal): Promise<'ack' | 'deferred'> {
    const parsed = taskDispatchSchema.parse(message);
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    return await this.locks.run(ownerId, parsed.taskType, parsed.taskId, signal,
      executionSignal => this.handleLocked(ownerId, parsed, executionSignal)) ?? 'deferred';
  }

  private async handleLocked(ownerId: string, message: TaskDispatch, signal: AbortSignal): Promise<'ack' | 'deferred'> {
    signal.throwIfAborted();
    const result = await this.store.claim(ownerId, message);
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
    let execution: Promise<SyntheticCompletion> | undefined;
    let executionError: unknown, executionFailed = false;
    try {
      let output: SyntheticCompletion | undefined, failure: TaskFailure | undefined, budgetInfrastructureError: unknown;
      try {
        execution = Promise.resolve().then(() => this.handler.execute(claim, abort.signal, {
          reserve: async usage => {
            abort.signal.throwIfAborted();
            try { await this.store.reserveUsage(claim, usage); }
            catch (error) { if (!(error instanceof TaskFailure)) budgetInfrastructureError = error; throw error; }
            abort.signal.throwIfAborted();
          },
        }));
        output = syntheticCompletionSchema.parse(await Promise.race([execution, interrupted]));
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
    } catch (error) {
      executionFailed = true; executionError = error;
    } finally {
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      signal.removeEventListener('abort', stop); removeAbort(); stop();
      await heartbeat; // heartbeat DB work is bounded; no detached lease extension after completion
    }
    // An AbortSignal race does not prove the graph or its saver has stopped. Keep the lock
    // until actual handler cleanup settles; uncertain execution must use a new thread next time.
    let settleTimer: NodeJS.Timeout | undefined;
    let settled: boolean;
    try {
      settled = await Promise.race([
        (execution ?? Promise.resolve()).then(() => true, () => true),
        new Promise<false>(resolve => { settleTimer = setTimeout(() => resolve(false), 5_000); }),
      ]);
    } finally { clearTimeout(settleTimer); }
    if (!settled) throw new ExecutionUnsettledError();
    try { await this.store.markExecutionStopped(claim); }
    catch (error) { if (executionFailed) throw new AggregateError([executionError, error], 'Execution and stopped-marker persistence failed', { cause: error }); throw error; }
    if (executionFailed) throw executionError;
    return 'ack';
  }
}
