import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import {
  IdentityModule, IDENTITY, DEVELOPMENT_OWNER_ID,
} from '../src/modules/identity/identity.module.js';
import type { IdentityPort } from '../src/modules/identity/identity.module.js';
import { TaskCreationService } from '../src/modules/tasks/task-creation.service.js';
import { TaskRepository } from '../src/infrastructure/tasks/task.repository.js';
import { requestHash } from '../src/modules/tasks/request-hash.js';
import {
  analysisInputSnapshotSchema, idempotencyKeySchema, taskDispatchSchema,
} from '../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from './support/task-inputs.js';

await test('identity defaults to one stable owner and can be replaced through the Nest port', async () => {
  const first = await Test.createTestingModule({ imports: [IdentityModule] }).compile();
  try {
    assert.equal(await first.get<IdentityPort>(IDENTITY).getOwnerId(), DEVELOPMENT_OWNER_ID);
    assert.equal(await first.get<IdentityPort>(IDENTITY).getOwnerId(), DEVELOPMENT_OWNER_ID);
  } finally { await first.close(); }
  const ownerId = randomUUID();
  const second = await Test.createTestingModule({ imports: [IdentityModule] })
    .overrideProvider(IDENTITY).useValue({ getOwnerId: () => Promise.resolve(ownerId) }).compile();
  try { assert.equal(await second.get<IdentityPort>(IDENTITY).getOwnerId(), ownerId); }
  finally { await second.close(); }
});

await test('canonical request hash ignores nested object order but binds all values and array order', () => {
  assert.equal(requestHash({ b: 2, a: { d: 4, c: 3 } }), requestHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(requestHash([1, 2]), requestHash([2, 1]));
  const input = analysisInput();
  assert.notEqual(requestHash(input), requestHash({ ...input, rubricVersion: 'synthetic-v2' }));
  assert.notEqual(requestHash(input), requestHash({ ...input, budget: { ...input.budget, maxAttempts: 2 } }));
  assert.throws(() => requestHash({ bad: undefined }));
  assert.throws(() => requestHash({ bad: Infinity }));
  assert.equal(idempotencyKeySchema.parse(DEVELOPMENT_OWNER_ID.toUpperCase()), DEVELOPMENT_OWNER_ID);
});

await test('creation rejects owner spoofing and malformed inputs before persistence', async () => {
  let calls = 0;
  const module = await Test.createTestingModule({
    imports: [IdentityModule], providers: [TaskCreationService, {
      provide: TaskRepository, useValue: {
        createAnalysis: () => { calls++; }, createJobIndex: () => { calls++; },
      },
    }],
  }).compile();
  try {
    const service = module.get(TaskCreationService), key = randomUUID();
    await assert.rejects(service.createAnalysis(key, { ...analysisInput(), ownerId: randomUUID() }));
    await assert.rejects(service.createJobIndex(key, { ...jobIndexInput(), ownerId: randomUUID() }));
    await assert.rejects(service.createAnalysis('invalid-key', analysisInput()));
    await assert.rejects(service.createAnalysis(key, { ...analysisInput(), resumeVersionId: undefined }));
    await assert.rejects(service.createAnalysis(key, { ...analysisInput(), asOfDate: '2026-02-30' }));
    await assert.rejects(service.createJobIndex(key, { ...jobIndexInput(), contentHash: 'invalid' }));
    await assert.rejects(service.createJobIndex(key, { ...jobIndexInput(), budget: { maxAttempts: -1 } }));
    assert.equal(calls, 0);
  } finally { await module.close(); }
});

await test('snapshots and dispatch contracts are strict and exclude arbitrary body/tracing data', () => {
  assert.throws(() => analysisInputSnapshotSchema.parse(analysisInput()));
  const message = {
    schemaVersion: 1, taskType: 'analysis', messageId: randomUUID(), taskId: randomUUID(),
    dispatchGeneration: 1, occurredAt: '2026-11-25T00:00:00.000Z',
  };
  assert.deepEqual(taskDispatchSchema.parse(message), message);
  assert.throws(() => taskDispatchSchema.parse({ ...message, resumeText: 'synthetic-only' }));
  assert.throws(() => taskDispatchSchema.parse({ ...message, dispatchGeneration: 0 }));
});
