import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';
import { IdempotencyConflictError } from '../../src/modules/tasks/task-errors.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { jobDraft } from '../support/job-inputs.js';

await test('S2.3 backfill persists no-op requests, rejects key reuse and cannot revive stale targets', { timeout: 60_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const owners = [randomUUID(), randomUUID()], ownerId = owners[0]!, other = owners[1]!;
  mkdirSync('data/s23-backfill-runs', { recursive: true }); const path = `data/s23-backfill-runs/${ownerId}.json`;
  const save = (cleaned = false) => writeFileSync(path, JSON.stringify({ owners, cleaned })); save();
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const id of owners) {
        await db.$transaction(async tx => {
          await tx.outboxEvent.deleteMany({ where: { ownerId: id } });
          await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } });
          await tx.jobIndexTask.deleteMany({ where: { ownerId: id } });
          await tx.jobVersion.deleteMany({ where: { ownerId: id } });
          await tx.job.deleteMany({ where: { ownerId: id } });
          await tx.owner.deleteMany({ where: { id } });
        });
        assert.equal(await db.jobIndexRequest.count({ where: { ownerId: id } }), 0);
      }
      save(true);
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of owners) await db.owner.create({ data: { id } });
  const jobs = new JobRepository(database), repository = new JobPublicationRepository(database), draft = jobDraft(ownerId);
  const target = jobIndexTargetSchema.parse({ embeddingVersion: 'fixture-only-v1', indexVersion: 'fixture-index-v1',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1', budget: { maxAttempts: 3, maxModelCalls: 10,
      maxTokens: 10000, maxCostMicros: 100, currency: 'CNY', maxDurationMs: 120_000 } });
  await jobs.createDraft(ownerId, draft);
  await repository.confirm(ownerId, draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
  const publicationKey = randomUUID(), published = await repository.publish(ownerId, draft.id, publicationKey, target);
  const noOpKey = randomUUID();
  const [first, concurrent] = await Promise.all([repository.ensureIndex(ownerId, draft.id, noOpKey, target), repository.ensureIndex(ownerId, draft.id, noOpKey, target)]);
  assert.deepEqual(first, { jobVersionId: draft.id, taskId: published.taskId, created: false });
  assert.deepEqual(concurrent, first);
  assert.equal(await db.jobIndexRequest.count({ where: { ownerId } }), 1);
  assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 1);
  await assert.rejects(repository.ensureIndex(ownerId, draft.id, noOpKey, { ...target, indexVersion: 'other' }), IdempotencyConflictError);
  await assert.rejects(repository.publish(ownerId, draft.id, noOpKey, target), IdempotencyConflictError);
  await assert.rejects(repository.ensureIndex(ownerId, draft.id, publicationKey, target), IdempotencyConflictError);
  await assert.rejects(repository.ensureIndex(other, draft.id, randomUUID(), target), /PUBLISHED_JOB_REQUIRED/);
  await assert.rejects(db.jobIndexRequest.update({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey: noOpKey } }, data: { requestHash: 'a'.repeat(64) } }));
  await assert.rejects(db.jobIndexRequest.create({ data: { ownerId: other, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64), taskId: published.taskId } }));

  const next = { ...target, indexVersion: 'fixture-index-v2' }, newKey = randomUUID();
  const rebuilt = await repository.ensureIndex(ownerId, draft.id, newKey, next);
  assert.equal(rebuilt.created, true);
  assert.deepEqual(await repository.ensureIndex(ownerId, draft.id, noOpKey, target), first);
  assert.equal((await db.jobIndexTarget.findUniqueOrThrow({ where: { jobVersionId: draft.id } })).taskId, rebuilt.taskId);
  assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 2);
  // A lost response after a real create also replays the original task after later retargeting.
  await repository.ensureIndex(ownerId, draft.id, randomUUID(), { ...target, indexVersion: 'fixture-index-v3' });
  assert.deepEqual(await repository.ensureIndex(ownerId, draft.id, newKey, next), { ...rebuilt, created: false });
  assert.equal((await db.jobIndexTarget.findUniqueOrThrow({ where: { jobVersionId: draft.id } })).indexVersion, 'fixture-index-v3');
  const beforeTasks = await db.jobIndexTask.count({ where: { ownerId } }), beforeOutbox = await db.outboxEvent.count({ where: { ownerId } });
  const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
    get(current, name, receiver) {
      if (name !== 'jobIndexRequest') return Reflect.get(current, name, receiver);
      return new Proxy(current.jobIndexRequest, { get(model, method, modelReceiver) {
        if (method !== 'create') return Reflect.get(model, method, modelReceiver);
        return (args: Prisma.JobIndexRequestCreateArgs) => model.create({ ...args, data: { ...args.data, requestHash: 'invalid' } });
      } });
    },
  }))) } };
  const failKey = randomUUID();
  await assert.rejects(new JobPublicationRepository(broken).ensureIndex(ownerId, draft.id, failKey, { ...target, indexVersion: 'fixture-index-v4' }));
  assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), beforeTasks);
  assert.equal(await db.outboxEvent.count({ where: { ownerId } }), beforeOutbox);
  assert.equal(await db.jobIndexRequest.count({ where: { ownerId, idempotencyKey: failKey } }), 0);
  assert.equal((await db.jobIndexTarget.findUniqueOrThrow({ where: { jobVersionId: draft.id } })).indexVersion, 'fixture-index-v3');
  const unchangedKey = randomUUID();
  await assert.rejects(new JobPublicationRepository(broken).ensureIndex(ownerId, draft.id, unchangedKey, { ...target, indexVersion: 'fixture-index-v3' }));
  assert.equal(await db.jobIndexRequest.count({ where: { ownerId, idempotencyKey: unchangedKey } }), 0);
  assert.equal((await repository.ensureIndex(ownerId, draft.id, unchangedKey, { ...target, indexVersion: 'fixture-index-v3' })).created, false);
});
