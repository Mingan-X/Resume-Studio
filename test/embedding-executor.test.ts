import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EmbeddingExecutor } from '../src/modules/embeddings/embedding-executor.js';
import type { EmbeddingReservation } from '../src/modules/embeddings/embedding-executor.js';
import { EmbeddingFailure } from '../src/modules/embeddings/embedding.port.js';
import type { EmbeddingPort, EmbeddingResponse } from '../src/modules/embeddings/embedding.port.js';
import { SyntheticEmbedding } from './support/synthetic-embedding.js';

const policy = { singleTimeoutMs: 100, totalTimeoutMs: 1000, maxAttempts: 3, retryBaseMs: 1, retryCapMs: 2,
  maxConcurrent: 1, inputTokenReservation: 1024, costReservationMicros: 10, maxTokens: 3072, maxCostMicros: 30, currency: 'CNY' };
const response: EmbeddingResponse = { vectors: [[1, 0]], usage: { inputTokens: 2, costMicros: null, currency: 'CNY' } };
function port(embed: EmbeddingPort['embed']): EmbeddingPort {
  return { embeddingVersion: 'fixture-only-v1', dimensions: 2, provenance: 'synthetic', embed };
}

await test('S2.3 embedding removes contact data before transport and synthetic vectors are deterministic test fixtures', async () => {
  let sent: string[] = [];
  const executor = new EmbeddingExecutor(port((texts) => { sent = texts; return Promise.resolve(response); }), policy);
  const result = await executor.run(['TypeScript 联系邮箱：synthetic@example.test\n电话 +86 13812345678']);
  assert.doesNotMatch(sent.join(), /synthetic@example|13812345678/);
  assert.match(sent.join(), /TypeScript/);
  assert.equal(result.usage?.costMicros, null); assert.equal(result.embeddingVersion, 'fixture-only-v1');
  const synthetic = new EmbeddingExecutor(new SyntheticEmbedding(), policy);
  assert.deepEqual((await synthetic.run(['合成技能检索'])).vectors, (await synthetic.run(['合成技能检索'])).vectors);
  assert.equal(synthetic.provenance, 'synthetic');
});

await test('S2.3 embedding retry shares durable reservations and never invents usage for failed calls', async () => {
  const reservations: EmbeddingReservation[] = []; let calls = 0;
  const executor = new EmbeddingExecutor(port(() => {
    if (++calls === 1) return Promise.reject(new EmbeddingFailure('RATE_LIMITED'));
    return Promise.resolve(response);
  }), policy);
  const result = await executor.run(['技能'], { reserve: value => { reservations.push(value); return Promise.resolve(); } });
  assert.equal(result.attempts, 2); assert.equal(result.usage, null); assert.equal(calls, 2);
  assert.deepEqual(reservations, Array.from({ length: 2 }, () => ({ modelCalls: 1, tokens: 1024, costMicros: 10 })));
  calls = 0;
  const bounded = new EmbeddingExecutor(port(() => { calls++; return Promise.reject(new EmbeddingFailure('UPSTREAM_5XX')); }),
    { ...policy, maxTokens: 1024 });
  await assert.rejects(bounded.run(['技能']), /BUDGET_EXHAUSTED/); assert.equal(calls, 1);
  const attempts = new EmbeddingExecutor(port(() => { calls++; return Promise.reject(new EmbeddingFailure('UNAVAILABLE')); }),
    { ...policy, maxAttempts: 2 });
  calls = 0; await assert.rejects(attempts.run(['技能']), /UNAVAILABLE/); assert.equal(calls, 2);
});

await test('S2.3 embedding invalid dimensions, batch cardinality and nonfinite values fail without retry', async () => {
  for (const vectors of [[[1]], [[1, 0], [0, 1]], [[Infinity, 0]], [[NaN, 0]]]) {
    let calls = 0;
    const executor = new EmbeddingExecutor(port(() => { calls++; return Promise.resolve({ vectors, usage: null }); }), policy);
    await assert.rejects(executor.run(['技能']), /OUTPUT_INVALID/); assert.equal(calls, 1);
  }
  for (const usage of [{ inputTokens: 1025, costMicros: 1, currency: 'CNY' },
    { inputTokens: 1, costMicros: 11, currency: 'CNY' }, { inputTokens: 1, costMicros: 1, currency: 'USD' }]) {
    const executor = new EmbeddingExecutor(port(() => Promise.resolve({ ...response, usage })), policy);
    await assert.rejects(executor.run(['技能']), /BUDGET_EXHAUSTED/);
  }
  let calls = 0;
  const executor = new EmbeddingExecutor(port(() => { calls++; return Promise.resolve(response); }), policy);
  await assert.rejects(executor.run(['技'.repeat(1000)]), /BUDGET_EXHAUSTED/); assert.equal(calls, 0);
});

await test('S2.3 embedding deadline covers retries and reservations; cancellation prevents further calls', async () => {
  let calls = 0;
  const executor = new EmbeddingExecutor(port(() => { calls++; return Promise.reject(new EmbeddingFailure('RATE_LIMITED')); }),
    { ...policy, singleTimeoutMs: 10, totalTimeoutMs: 30, retryBaseMs: 100, retryCapMs: 100 });
  await assert.rejects(executor.run(['技能']), /DEADLINE_EXCEEDED/); assert.equal(calls, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(executor.run(['技能'], { signal: abort.signal }), /CANCELLED/); assert.equal(calls, 1);
  let release: (() => void) | undefined;
  const reserve = new Promise<void>(resolve => { release = resolve; });
  const waiting = new EmbeddingExecutor(port(() => { calls++; return Promise.resolve(response); }),
    { ...policy, singleTimeoutMs: 20, totalTimeoutMs: 40 });
  await assert.rejects(waiting.run(['技能'], { reserve: () => reserve }), /DEADLINE_EXCEEDED/);
  await assert.rejects(waiting.run(['技能']), /BUSY/); assert.equal(calls, 1);
  release!(); await delay(0);
  assert.equal((await waiting.run(['技能'])).attempts, 1);
});

await test('S2.3 unsettled embedding holds concurrency slot; abort-compliant transport respects single timeout', async () => {
  let release: ((result: EmbeddingResponse) => void) | undefined, calls = 0;
  const hanging = new Promise<EmbeddingResponse>(resolve => { release = resolve; });
  const executor = new EmbeddingExecutor(port(() => ++calls === 1 ? hanging : Promise.resolve(response)),
    { ...policy, singleTimeoutMs: 20 });
  await assert.rejects(executor.run(['技能']), /UNSETTLED/);
  await assert.rejects(executor.run(['技能']), /BUSY/); assert.equal(calls, 1);
  release!(response); await delay(0);
  assert.equal((await executor.run(['技能'])).attempts, 1);
  calls = 0;
  const cancellable = new EmbeddingExecutor(port((_texts, signal) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new EmbeddingFailure('TIMEOUT')), { once: true }));
  }), { ...policy, singleTimeoutMs: 20, maxAttempts: 1 });
  await assert.rejects(cancellable.run(['技能']), /TIMEOUT/); assert.equal(calls, 1);
});
