import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { AnalysisModelCaller } from '../src/modules/analysis/model-caller.js';
import { ModelExecutor, modelExecutionPolicySchema } from '../src/modules/models/model-executor.js';
import { ModelFailure } from '../src/modules/models/model.port.js';
import { TaskFailure } from '../src/infrastructure/consumer/failure.js';
import type { ExecutionClaim } from '../src/infrastructure/consumer/contracts.js';
import { realAnalysisInputSchema } from '../src/contracts/tasks.js';
import type { UsageReservation } from '../src/contracts/tasks.js';
import { analysisConfiguration } from './support/analysis-inputs.js';

function claim(calls = 4): ExecutionClaim & { snapshot: z.infer<typeof realAnalysisInputSchema> } {
  const ownerId = randomUUID(), taskId = randomUUID(), config = analysisConfiguration();
  return { ownerId, consumerName: 'analysis.worker.v1', message: { schemaVersion: 1, messageId: randomUUID(), taskType: 'analysis', taskId,
    dispatchGeneration: 1, occurredAt: new Date().toISOString() }, attemptId: randomUUID(), fenceToken: 1n,
    startedAt: new Date(), deadline: new Date(Date.now() + 5000), graph: { threadId: taskId, generation: 1 },
    snapshot: realAnalysisInputSchema.parse({ ...config, kind: 'analysis', ownerId, resumeVersionId: randomUUID(), asOfDate: '2026-11-27',
      jobCorpusVersionId: 'test-corpus-v1', budget: { ...config.budget, maxModelCalls: calls, maxTokens: 100000, maxCostMicros: 10000 },
      configurationHash: 'a'.repeat(64), resumeFileHash: 'b'.repeat(64), corpusHash: 'c'.repeat(64), rubricHash: 'd'.repeat(64) }) };
}
const policy = modelExecutionPolicySchema.parse({ singleTimeoutMs: 1000, totalTimeoutMs: 5000, maxAttempts: 4, maxRetries: 1,
  maxTokens: 100000, maxCostMicros: 10000, currency: 'CNY', inputTokenReservation: 5000, maxOutputTokens: 100,
  costReservationMicros: 100, retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 3 });
const schema = z.object({ answer: z.literal('supported') }).strict();
const input = { stage: 'extract' as const, instructions: '仅提取有证据的数据', data: '合成联系 sample@example.test', schema,
  validate: (raw: unknown) => schema.parse(raw) };
function ledger(task: ExecutionClaim) {
  const usage = { modelCalls: 0, tokens: 0, costMicros: 0 };
  return { usage, reserve: async (delta: UsageReservation) => {
    for (const [key, cap] of [['modelCalls', task.snapshot.budget.maxModelCalls], ['tokens', task.snapshot.budget.maxTokens],
      ['costMicros', task.snapshot.budget.maxCostMicros]] as const) {
      if (delta[key] > cap - usage[key]) throw new TaskFailure('BUDGET_EXHAUSTED');
    }
    usage.modelCalls += delta.modelCalls; usage.tokens += delta.tokens; usage.costMicros += delta.costMicros;
  } };
}

await test('analysis model repair and recovered invocations share reservations; observations receive no input', async () => {
  const task = claim(2), budget = ledger(task); let calls = 0;
  const model = new ModelExecutor({ modelConfigVersion: task.snapshot.modelConfigVersion, invoke: async request => {
    calls++; assert.equal(budget.usage.modelCalls, calls);
    assert.doesNotMatch(JSON.stringify(request.messages), /sample@example/);
    return { output: calls === 1 ? { answer: 'invalid' } : { answer: 'supported' }, usage: null };
  } }, policy);
  const observed: string[] = [];
  const caller = new AnalysisModelCaller(model, { run: async (id, stage, run) => { observed.push(id, stage); return run(); } });
  const result = await caller.run(task, budget, input, new AbortController().signal);
  assert.equal(result.attempts, 2); assert.equal(result.usage, null); assert.equal(calls, 2);
  assert.deepEqual(budget.usage, { modelCalls: 2, tokens: 10200, costMicros: 200 });
  const recovered = { ...task, attemptId: randomUUID(), fenceToken: 2n };
  await assert.rejects(new AnalysisModelCaller(model).run(recovered, budget, input, new AbortController().signal), /BUDGET_EXHAUSTED/);
  assert.equal(calls, 2); assert.deepEqual(observed, [task.message.taskId, 'extract']);
});
await test('analysis transient retries reserve each call and concurrent branches cannot reset shared budget', async () => {
  const task = claim(2), budget = ledger(task); let calls = 0;
  const model = new ModelExecutor({ modelConfigVersion: task.snapshot.modelConfigVersion, invoke: async () => {
    calls++; if (calls === 1) throw new ModelFailure('RATE_LIMITED'); return { output: { answer: 'supported' }, usage: null };
  } }, policy);
  assert.equal((await new AnalysisModelCaller(model).run(task, budget, input, new AbortController().signal)).attempts, 2);
  assert.equal(budget.usage.modelCalls, 2);
  const next = claim(2), shared = ledger(next); let parallelCalls = 0;
  const caller = new AnalysisModelCaller(new ModelExecutor({ modelConfigVersion: next.snapshot.modelConfigVersion, invoke: async () => {
    parallelCalls++; await delay(5); return { output: { answer: 'supported' }, usage: null };
  } }, policy));
  const results = await Promise.allSettled([1, 2, 3].map(() => caller.run(next, shared, input, new AbortController().signal)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2); assert.equal(parallelCalls, 2);
  assert.equal(shared.usage.modelCalls, 2);
});
await test('analysis rejects version/currency mismatches, expired/cancelled work and reservation failure before transport', async () => {
  const task = claim(); let calls = 0;
  const port = { modelConfigVersion: task.snapshot.modelConfigVersion, invoke: async () => { calls++; return { output: { answer: 'supported' }, usage: null }; } };
  const caller = new AnalysisModelCaller(new ModelExecutor(port, policy));
  const budget = ledger(task), signal = new AbortController();
  await assert.rejects(caller.run({ ...task, snapshot: { ...task.snapshot, modelConfigVersion: 'other' } }, budget, input, signal.signal), /UNSUPPORTED_INPUT/);
  await assert.rejects(new AnalysisModelCaller(new ModelExecutor(port, { ...policy, currency: 'USD' })).run(task, budget, input, signal.signal), /UNSUPPORTED_INPUT/);
  await assert.rejects(caller.run({ ...task, deadline: new Date(0) }, budget, input, signal.signal), /DEADLINE_EXCEEDED/);
  const failure = new Error('TEST_RESERVATION_DB_FAILURE');
  await assert.rejects(caller.run(task, { reserve: async () => { throw failure; } }, input, signal.signal), error => error === failure);
  signal.abort(); await assert.rejects(caller.run(task, budget, input, signal.signal));
  assert.equal(calls, 0); assert.equal(budget.usage.modelCalls, 0);
});
await test('analysis deadline stops transport after slow reservation and drains it before returning', async () => {
  const task = claim(); let calls = 0, settled = false;
  const caller = new AnalysisModelCaller(new ModelExecutor({ modelConfigVersion: task.snapshot.modelConfigVersion,
    invoke: async () => { calls++; return { output: { answer: 'supported' }, usage: null }; } }, { ...policy, singleTimeoutMs: 25, totalTimeoutMs: 25 }));
  await assert.rejects(caller.run(task, { reserve: async () => { await delay(50); settled = true; } }, input, new AbortController().signal), /DEADLINE_EXCEEDED/);
  assert.equal(calls, 0); assert.equal(settled, true);
});
