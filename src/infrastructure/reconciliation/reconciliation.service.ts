import { setTimeout as delay } from 'node:timers/promises';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import type { TaskType } from '../../contracts/tasks.js';
import type { TaskExecutionStore } from '../consumer/task-execution.store.js';
import type { OutboxPublisher } from '../outbox/outbox.publisher.js';
import type { ReconciliationConfig } from './config.js';
import type { ReconciliationStore } from './reconciliation.store.js';

export class ReconciliationService {
  private readonly cursors: Partial<Record<TaskType, string>> = {};
  private running = false;
  constructor(private readonly store: Pick<ReconciliationStore, 'candidates' | 'pendingSummary'>,
    private readonly tasks: Pick<TaskExecutionStore, 'reconcile'>, private readonly publisher: Pick<OutboxPublisher, 'runOnce'>,
    private readonly identity: IdentityPort, private readonly config: ReconciliationConfig) {}

  async runOnce(signal?: AbortSignal) {
    if (this.running) throw new Error('RECONCILIATION_ALREADY_RUNNING');
    this.running = true;
    const deadline = AbortSignal.timeout(this.config.cycleTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
      const tasks: string[] = [], publications: string[] = [];
      for (const type of ['analysis', 'job-index'] as const) {
        if (combined.aborted) break;
        const ids = await this.store.candidates(ownerId, type, this.cursors[type], this.config.pageSize, this.config.staleMs);
        for (const id of ids) {
          if (combined.aborted) break;
          try { tasks.push(await this.tasks.reconcile(ownerId, type, id, this.config)); }
          catch { tasks.push('error'); }
          this.cursors[type] = id; // locked/invalid rows cannot starve later tasks
        }
        if (!combined.aborted && ids.length < this.config.pageSize) delete this.cursors[type];
      }
      // Publishing happens strictly after repair transactions. T3 owns delivery leases and budgets.
      for (let index = 0; index < this.config.pageSize && !combined.aborted; index++) {
        const result = await this.publisher.runOnce(combined);
        publications.push(result);
        if (result === 'idle' || result === 'stopped') break;
      }
      const outbox = combined.aborted ? null : await this.store.pendingSummary(ownerId);
      return { tasks, publications, outbox, stopped: combined.aborted };
    } finally { this.running = false; }
  }

  async watch(signal: AbortSignal, report: (summary: Awaited<ReturnType<ReconciliationService['runOnce']>>) => void) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const summary = await this.runOnce(signal); report(summary);
        failures = summary.tasks.includes('error') ? failures + 1 : 0;
      } catch {
        if (signal.aborted) return;
        failures++;
      }
      if (failures >= this.config.maxConsecutiveErrors) throw new Error('RECONCILIATION_FAILURE_LIMIT');
      try { await delay(this.config.intervalMs, undefined, { signal }); }
      catch { if (!signal.aborted) throw new Error('RECONCILIATION_WAIT_FAILED'); }
    }
  }
}
