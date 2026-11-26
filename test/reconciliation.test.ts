import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { reconciliationConfigSchema } from '../src/infrastructure/reconciliation/config.js';
import { ReconciliationService } from '../src/infrastructure/reconciliation/reconciliation.service.js';
import { executionLockKey } from '../src/infrastructure/consumer/task-execution.lock.js';

const summary = { pending: 0, due: 0, failed: 0, oldestCreatedAt: null };

await test('execution lock key is stable, normalizes UUIDs and separates owner/type/task', () => {
  const owner = randomUUID(), id = randomUUID();
  const key = executionLockKey(owner, 'analysis', id);
  assert.equal(key, executionLockKey(owner.toUpperCase(), 'analysis', id.toUpperCase()));
  assert.notEqual(key, executionLockKey(owner, 'job-index', id));
  assert.notEqual(key, executionLockKey(randomUUID(), 'analysis', id));
  assert.notEqual(key, executionLockKey(owner, 'analysis', randomUUID()));
  assert.ok(BigInt(key) >= -(2n ** 63n) && BigInt(key) < 2n ** 63n);
  assert.throws(() => executionLockKey('invalid', 'analysis', id));
  assert.throws(() => reconciliationConfigSchema.parse({ pageSize: 0 }));
});

await test('bounded pages advance past held locks, wrap, and publish only after task transactions', async () => {
  const ids = [randomUUID(), randomUUID()], cursors: (string | undefined)[] = [], order: string[] = [];
  const service = new ReconciliationService({ candidates: (_owner, type, after) => {
    if (type === 'job-index') return Promise.resolve([]);
    cursors.push(after); return Promise.resolve(after === ids[0] ? [ids[1]!] : after === ids[1] ? [] : [ids[0]!]);
  }, pendingSummary: () => Promise.resolve(summary) }, { reconcile: async () => {
    order.push('begin'); await delay(5); order.push('committed'); return 'lock-held';
  } }, { runOnce: () => { order.push('publish'); return Promise.resolve('idle'); } },
  { getOwnerId: () => Promise.resolve(randomUUID()) }, reconciliationConfigSchema.parse({ pageSize: 1 }));
  for (let index = 0; index < 4; index++) await service.runOnce();
  assert.deepEqual(cursors, [undefined, ids[0], ids[1], undefined]);
  assert.deepEqual(order, ['begin','committed','publish','begin','committed','publish','publish','begin','committed','publish']);
});

await test('periodic scans do not overlap, cancel cleanly and stop after bounded consecutive failures', async () => {
  const abort = new AbortController(); let active = 0, peak = 0, cycles = 0;
  const config = reconciliationConfigSchema.parse({ intervalMs: 100, maxConsecutiveErrors: 2 });
  const store = { candidates: () => Promise.resolve([]), pendingSummary: async () => {
    active++; peak = Math.max(peak, active); await delay(130); active--; return summary;
  } };
  const service = new ReconciliationService(store, { reconcile: () => Promise.resolve('skipped') }, { runOnce: () => Promise.resolve('idle') },
    { getOwnerId: () => Promise.resolve(randomUUID()) }, config);
  await service.watch(abort.signal, () => { if (++cycles === 2) abort.abort(); });
  assert.equal(cycles, 2); assert.equal(peak, 1);
  const pending = service.runOnce(); await assert.rejects(service.runOnce(), /ALREADY_RUNNING/); await pending;
  let failures = 0;
  const broken = new ReconciliationService({ candidates: () => { failures++; return Promise.reject(new Error('private SQL')); }, pendingSummary: store.pendingSummary },
    { reconcile: () => Promise.resolve('skipped') }, { runOnce: () => Promise.resolve('idle') },
    { getOwnerId: () => Promise.resolve(randomUUID()) }, config);
  await assert.rejects(broken.watch(new AbortController().signal, () => {}), /FAILURE_LIMIT/);
  assert.equal(failures, 2);
});
