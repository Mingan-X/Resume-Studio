import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { taskDispatchSchema } from '../src/contracts/tasks.js';
import { consumerConfigSchema } from '../src/infrastructure/consumer/config.js';
import { decodeTaskDelivery, ExecutionLeaseLostError } from '../src/infrastructure/consumer/contracts.js';
import type { ExecutionClaim } from '../src/infrastructure/consumer/contracts.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../src/infrastructure/consumer/task-delivery.handler.js';
import { analysisInput } from './support/task-inputs.js';
import { unlockedUnitContext } from './support/execution-lock.js';

function fixture() {
  const ownerId = randomUUID();
  const message = taskDispatchSchema.parse({ schemaVersion: 1, messageId: randomUUID(), taskId: randomUUID(),
    taskType: 'analysis', dispatchGeneration: 1, occurredAt: new Date().toISOString() });
  const claim: ExecutionClaim = { ownerId, message, consumerName: 'analysis.worker.v1', attemptId: randomUUID(),
    fenceToken: 1n, startedAt: new Date(), deadline: new Date(Date.now() + 5_000), snapshot: { ...analysisInput(), ownerId } };
  return { ownerId, message, claim, identity: { getOwnerId: () => Promise.resolve(ownerId) } };
}

await test('consumer validates bounded body, task type, message ID, content type and route', () => {
  const { message } = fixture();
  const delivery = { content: Buffer.from(JSON.stringify(message)),
    properties: { contentType: 'application/json', messageId: message.messageId },
    fields: { consumerTag: 'synthetic', deliveryTag: 1, redelivered: false, exchange: 'resume.tasks', routingKey: 'analysis.requested.v1' } };
  assert.deepEqual(decodeTaskDelivery(delivery, 'analysis', 'resume.tasks'), message);
  for (const changed of [
    { content: Buffer.from('{bad') }, { content: Buffer.alloc(8193) },
    { content: Buffer.from(JSON.stringify({ ...message, ownerId: randomUUID() })) },
    { properties: { ...delivery.properties, messageId: randomUUID() } },
    { properties: { ...delivery.properties, contentType: 'text/plain' } },
    { fields: { ...delivery.fields, routingKey: 'job.index.requested.v1' } },
  ]) assert.throws(() => decodeTaskDelivery({ ...delivery, ...changed }, 'analysis', 'resume.tasks'));
  assert.throws(() => consumerConfigSchema.parse({ heartbeatMs: 1000, leaseMs: 2000 }));
});

await test('heartbeat failure aborts work and prevents completion even when handler returns late', async () => {
  const f = fixture(); let completed = 0, beats = 0, aborted = false;
  const handler = new TaskDeliveryHandler({ cancelAtBoundary: () => Promise.resolve(false), markExecutionStopped: () => Promise.resolve(), fail: () => { assert.fail('Heartbeat failure must not be recorded as task failure'); },
    reserveUsage: () => Promise.resolve(), claim: () => Promise.resolve({ kind: 'acquired', claim: f.claim }),
    heartbeat: () => { beats++; return Promise.reject(new Error('database unavailable')); },
    complete: () => { completed++; return Promise.resolve(); },
  }, f.identity, { execute: async (claim, signal) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await delay(250);
    return new SyntheticCompletionHandler().execute(claim, new AbortController().signal);
  } }, consumerConfigSchema.parse({ heartbeatMs: 100, leaseMs: 2000 }), unlockedUnitContext);
  await assert.rejects(handler.handle(f.message, new AbortController().signal));
  await delay(250);
  assert.equal(aborted, true); assert.equal(completed, 0); assert.equal(beats, 1);
});

await test('terminal and deferred dispositions never execute; successful ACK decision follows complete', async () => {
  const f = fixture(); let completed = false;
  for (const kind of ['ack', 'deferred'] as const) {
    const handler = new TaskDeliveryHandler({ cancelAtBoundary: () => Promise.resolve(false), markExecutionStopped: () => Promise.resolve(), fail: () => { assert.fail('No task failure expected'); },
      reserveUsage: () => Promise.resolve(), claim: () => Promise.resolve({ kind }),
      heartbeat: () => { assert.fail('No heartbeat expected'); }, complete: () => { assert.fail('No completion expected'); },
    }, f.identity, { execute: () => { assert.fail('No execution expected'); } }, consumerConfigSchema.parse({}), unlockedUnitContext);
    assert.equal(await handler.handle(f.message, new AbortController().signal), kind);
  }
  const handler = new TaskDeliveryHandler({ cancelAtBoundary: () => Promise.resolve(false), markExecutionStopped: () => Promise.resolve(), fail: () => { assert.fail('No task failure expected'); },
    reserveUsage: () => Promise.resolve(), claim: () => Promise.resolve({ kind: 'acquired', claim: f.claim }),
    heartbeat: () => Promise.resolve(), complete: async () => { await delay(10); completed = true; },
  }, f.identity, new SyntheticCompletionHandler(), consumerConfigSchema.parse({}), unlockedUnitContext);
  assert.equal(await handler.handle(f.message, new AbortController().signal), 'ack'); assert.equal(completed, true);
});

await test('cancellation retains execution lock until actual handler settlement before marking stopped', async () => {
  const f = fixture(), abort = new AbortController(); let locked = false, stopped = false, completed = false;
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const handler = new TaskDeliveryHandler({ claim: () => Promise.resolve({ kind: 'acquired', claim: f.claim }),
    cancelAtBoundary: () => Promise.resolve(false),
    heartbeat: () => Promise.resolve(), reserveUsage: () => Promise.resolve(),
    fail: () => { assert.fail('Cancellation must not become business failure'); },
    complete: () => { completed = true; return Promise.resolve(); },
    markExecutionStopped: () => { assert.equal(locked,true); stopped=true; return Promise.resolve(); },
  }, f.identity, { execute: async claim => { ready(); await pending; return new SyntheticCompletionHandler().execute(claim,new AbortController().signal); } },
  consumerConfigSchema.parse({}), { run: async (_owner,_type,_task,signal,work) => { locked=true; try{return await work(signal);} finally{locked=false;} } });
  const work = handler.handle(f.message,abort.signal), rejection=assert.rejects(work);
  await started; abort.abort(); await delay(25);
  assert.equal(locked,true);assert.equal(stopped,false);assert.equal(completed,false);
  release();await rejection;assert.equal(stopped,true);assert.equal(locked,false);assert.equal(completed,false);
});

await test('heartbeat finishing after the frozen deadline still finalizes timeout through the fenced store', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  for (const mode of ['finalize', 'database-failure', 'fence-changed'] as const) {
  const f = fixture(); let timedOut = false, stopped = false;
  let beatStarted!: () => void, rejectBeat!: (error: Error) => void;
  const started = new Promise<void>(resolve => { beatStarted = resolve; });
  const beat = new Promise<void>((_resolve, reject) => { rejectBeat = reject; });
  const handler = new TaskDeliveryHandler({ claim: () => Promise.resolve({ kind: 'acquired', claim: f.claim }),
    cancelAtBoundary: () => Promise.resolve(false), reserveUsage: () => Promise.resolve(),
    heartbeat: () => { beatStarted(); return beat; },
    complete: () => { assert.fail('No output after deadline'); },
    fail: (_claim, error) => {
      assert.notEqual(mode, 'database-failure'); assert.equal(error.code, 'DEADLINE_EXCEEDED');
      if (mode === 'fence-changed') return Promise.reject(new ExecutionLeaseLostError());
      timedOut = true; return Promise.resolve();
    },
    markExecutionStopped: () => { stopped = true; return Promise.resolve(); },
  }, f.identity, { execute: (_claim, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) }, consumerConfigSchema.parse({ heartbeatMs: 100, leaseMs: 2000 }), unlockedUnitContext);
  const work = handler.handle(f.message, new AbortController().signal);
  const result = work.then(value => ({ value }), error => ({ error: error instanceof Error ? error.message : 'unknown' }));
  // Flush the identity/lock/claim continuations before advancing mocked wall time.
  for (let index = 0; index < 12; index++) await Promise.resolve();
  t.mock.timers.tick(100); await started;
  t.mock.timers.tick(5_000); rejectBeat(mode === 'database-failure' ? new Error('database unavailable') : new ExecutionLeaseLostError());
  const disposition = await result;
  if (mode === 'finalize') assert.deepEqual(disposition, { value: 'ack' });
  else assert.ok('error' in disposition, 'Infrastructure/fence failure must not ACK');
  assert.equal(timedOut, mode === 'finalize'); assert.equal(stopped, true);
  }
});
