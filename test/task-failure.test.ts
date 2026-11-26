import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';
import { TaskFailure, classifyTaskFailure, isRetryable, executionRetryDelay } from '../src/infrastructure/consumer/failure.js';
import { deadMessageSchema } from '../src/contracts/tasks.js';
import { outboundFromClaim } from '../src/infrastructure/outbox/outbox.publisher.js';

await test('retry classes are explicit, unknown faults are safe permanent errors, delay is bounded', () => {
  for (const code of ['UPSTREAM_TIMEOUT','RATE_LIMITED','DEPENDENCY_UNAVAILABLE','UPSTREAM_5XX'] as const) {
    assert.equal(classifyTaskFailure(new TaskFailure(code)).code, code); assert.equal(isRetryable(code), true);
  }
  for (const code of ['INPUT_INVALID','UNSUPPORTED_INPUT','OUTPUT_INVALID','EXECUTION_FAILED','BUDGET_EXHAUSTED','DEADLINE_EXCEEDED'] as const) {
    assert.equal(isRetryable(code), false);
  }
  const raw = new Error('password=synthetic-secret contact@example.invalid');
  assert.equal(classifyTaskFailure(raw).message, 'EXECUTION_FAILED');
  const invalid = z.object({ value: z.int() }).safeParse({ value: 'invalid' }); assert.equal(invalid.success, false);
  if (!invalid.success) assert.equal(classifyTaskFailure(invalid.error).code, 'OUTPUT_INVALID');
  assert.equal(executionRetryDelay(1, 0), 24_000); assert.equal(executionRetryDelay(1, 1), 30_000);
  assert.equal(executionRetryDelay(2, 0), 96_000); assert.equal(executionRetryDelay(20, 1), 120_000);
});

await test('dead envelopes validate task/quarantine references and exclude raw input/error data', () => {
  for (const kind of ['task', 'quarantine'] as const) {
    const id = randomUUID(), eventId = randomUUID();
    const payload = deadMessageSchema.parse({ schemaVersion: 1, kind: 'dead', messageId: eventId, taskType: 'analysis',
      occurredAt: new Date().toISOString(), originalMessageId: null, errorCode: kind === 'task' ? 'INPUT_INVALID' : 'MALFORMED_MESSAGE',
      source: kind === 'task' ? { kind, taskId: id, dispatchGeneration: 1 } : { kind, quarantineId: id, messageHash: 'a'.repeat(64) } });
    const claim = { eventId, ownerId: randomUUID(), aggregateType: kind === 'task' ? 'AnalysisTask' : 'Quarantine', aggregateId: id,
      eventType: 'analysis.dead.v1', payloadVersion: 1, payload, publishAttempts: 1, leaseOwner: randomUUID(), createdAt: new Date(), failedAt: null };
    assert.deepEqual(outboundFromClaim(claim), payload);
    assert.throws(() => outboundFromClaim({ ...claim, aggregateId: randomUUID() }));
    assert.throws(() => outboundFromClaim({ ...claim, eventType: 'job.index.dead.v1' }));
    assert.throws(() => deadMessageSchema.parse({ ...payload, errorMessage: 'secret' }));
    assert.throws(() => deadMessageSchema.parse({ ...payload, source: { ...payload.source, body: 'resume' } }));
  }
});
