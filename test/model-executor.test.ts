import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ModelExecutor } from '../src/modules/models/model-executor.js';
import { ModelFailure } from '../src/modules/models/model.port.js';
import type { ModelPort, ModelResponse } from '../src/modules/models/model.port.js';

const policy = { singleTimeoutMs: 500, totalTimeoutMs: 2000, maxAttempts: 4, maxRetries: 2, maxTokens: 100000,
  maxCostMicros: 4000, currency: 'CNY', inputTokenReservation: 20000, maxOutputTokens: 100,
  costReservationMicros: 1000, retryBaseMs: 5, retryCapMs: 20, maxConcurrent: 1 };
const schema = z.object({ value: z.string() }).strict();
const request = () => ({ messages: [new HumanMessage('合成数据')], schema, validate: (input: unknown) => schema.parse(input),
  repairMessages: () => [new HumanMessage('合成修复数据')] });
const good = (): ModelResponse => ({ output: { value: 'ok' }, usage: { inputTokens: 10, outputTokens: 2, costMicros: 7, currency: 'CNY' } });
const port = (invoke: ModelPort['invoke']): ModelPort => ({ modelConfigVersion: 'test-v1', invoke });

await test('model retries and one repair share reservations; missing usage is never charged as zero', async () => {
  let calls = 0; const reservations: unknown[] = [];
  const executor = new ModelExecutor(port(async () => {
    calls++; if (calls === 1) throw new ModelFailure('RATE_LIMITED');
    if (calls === 2) return { ...good(), output: { value: 'bad', totalScore: 100 } };
    return good();
  }), policy);
  const result = await executor.run({ ...request(), reserve: async value => { reservations.push(value); } });
  assert.equal(result.attempts, 3); assert.equal(reservations.length, 3); assert.equal(result.usage, null);
  assert.deepEqual(result.output, { value: 'ok' });
  const unknown = await new ModelExecutor(port(async () => ({ ...good(), usage: null })), policy).run(request());
  assert.equal(unknown.usage, null);
  let repair = 0;
  await assert.rejects(new ModelExecutor(port(async () => { repair++; return { ...good(), output: { totalScore: 1 } }; }), policy).run(request()), /OUTPUT_INVALID/);
  assert.equal(repair, 2);
});
await test('known token/cost totals include invalid output repair and nullable cost remains unknown', async () => {
  let calls = 0;
  const executor = new ModelExecutor(port(async () => ++calls === 1 ? { ...good(), output: {} } : good()), policy);
  assert.deepEqual((await executor.run(request())).usage, { inputTokens: 20, outputTokens: 4, costMicros: 14, currency: 'CNY' });
  const unknownCost = await new ModelExecutor(port(async () => ({ ...good(), usage: { inputTokens: 1, outputTokens: 1, costMicros: null, currency: 'CNY' } })), policy).run(request());
  assert.equal(unknownCost.usage?.costMicros, null);
});
await test('budgets refuse oversized input, repeated retries, excess usage and failed durable reservations', async () => {
  let calls = 0; const backend = port(async () => { calls++; throw new ModelFailure('UPSTREAM_5XX'); });
  await assert.rejects(new ModelExecutor(backend, { ...policy, maxCostMicros: 1000 }).run(request()), /BUDGET_EXHAUSTED/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(new ModelExecutor(backend, { ...policy, inputTokenReservation: 10 }).run(request()), /BUDGET_EXHAUSTED/);
  await assert.rejects(new ModelExecutor(backend, policy).run({ ...request(), reserve: async () => { throw new Error('DB_RESERVATION_FAILED'); } }), /DB_RESERVATION_FAILED/);
  assert.equal(calls, 0);
  await assert.rejects(new ModelExecutor(port(async () => ({ ...good(), usage: { inputTokens: 1, outputTokens: 101, costMicros: 2, currency: 'CNY' } })), policy).run(request()), /BUDGET_EXHAUSTED/);
});
await test('total deadline covers backoff and hung reservations and prevents any later network call', async () => {
  let calls = 0;
  const executor = new ModelExecutor(port(async () => { calls++; throw new ModelFailure('RATE_LIMITED'); }),
    { ...policy, singleTimeoutMs: 50, totalTimeoutMs: 50, retryBaseMs: 100, retryCapMs: 100 });
  await assert.rejects(executor.run(request()), /DEADLINE_EXCEEDED/); assert.equal(calls, 1);
  let release!: () => void; const reserved = new Promise<void>(resolve => { release = resolve; });
  const bounded = new ModelExecutor(port(async () => { calls++; return good(); }), { ...policy, singleTimeoutMs: 50, totalTimeoutMs: 50 });
  await assert.rejects(bounded.run({ ...request(), reserve: () => reserved }), /DEADLINE_EXCEEDED/);
  assert.equal(calls, 1); release(); await delay(5); assert.equal(calls, 1);
});
await test('unsettled transport retains concurrency slot and cannot overlap retries; cancellation is bounded', async () => {
  let release!: (value: ModelResponse) => void, calls = 0;
  const pending = new Promise<ModelResponse>(resolve => { release = resolve; });
  const executor = new ModelExecutor(port(() => { calls++; return pending; }), { ...policy, singleTimeoutMs: 30 });
  await assert.rejects(executor.run(request()), /UNSETTLED/);
  await assert.rejects(executor.run(request()), /BUSY/); assert.equal(calls, 1);
  release(good()); await delay(5);
  assert.equal((await executor.run(request())).output.value, 'ok');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(executor.run({ ...request(), signal: aborted.signal }), /CANCELLED/);
});
await test('permanent failures do not retry and observation errors cannot fail successful work', async () => {
  let calls = 0;
  await assert.rejects(new ModelExecutor(port(async () => { calls++; throw new ModelFailure('UNSUPPORTED_MODEL'); }), policy).run(request()), /UNSUPPORTED_MODEL/);
  assert.equal(calls, 1);
  assert.equal((await new ModelExecutor(port(async () => good()), policy, () => { throw new Error('observation down'); }).run(request())).output.value, 'ok');
});
