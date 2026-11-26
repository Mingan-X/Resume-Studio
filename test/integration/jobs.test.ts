import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import { jobIndexInputSnapshotSchema, taskDispatchSchema, budgetUsageSchema } from '../../src/contracts/tasks.js';
import { jobDraft, syntheticRubric } from '../support/job-inputs.js';
import { jobIndexInput } from '../support/task-inputs.js';

await test('S2.2 PostgreSQL jobs, immutable publications, rubrics and real task foreign keys', { timeout: 90_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const repository = new JobRepository(database), owners: string[] = [];
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where: { ownerId } }); await tx.taskEvent.deleteMany({ where: { ownerId } });
          await tx.taskAttempt.deleteMany({ where: { ownerId } }); await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.jobIndexTask.deleteMany({ where: { ownerId } });
          await tx.jobVersion.deleteMany({ where: { ownerId } });
          await tx.job.deleteMany({ where: { ownerId } }); await tx.rubricVersion.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        for (const count of await Promise.all([db.job.count({ where: { ownerId } }), db.jobVersion.count({ where: { ownerId } }),
          db.jobRequirement.count({ where: { ownerId } }), db.rubricVersion.count({ where: { ownerId } }), db.jobIndexTask.count({ where: { ownerId } })])) assert.equal(count, 0);
      }
      t.diagnostic('S2.2 exact-run owners/jobs/versions/requirements/rubrics/tasks removed; no shared records changed');
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of [randomUUID(), randomUUID()]) { await db.owner.create({ data: { id } }); owners.push(id); }
  const ownerId = owners[0]!, other = owners[1]!, input = jobDraft(ownerId);
  await repository.createDraft(ownerId, input);
  const publish = (id: string) => db.jobVersion.update({ where: { id, ownerId }, data: {
    status: 'PUBLISHED', publishedAt: new Date(), contentHash: 'a'.repeat(64), indexStatus: 'PENDING',
    hardRequirementsConfirmed: true, weightsConfirmed: true,
  } });

  await t.test('owner and version identity are protected in reads, writes and composite foreign keys', async () => {
    assert.deepEqual(await repository.findVersion(ownerId, input.id), input);
    assert.equal(await repository.findVersion(other, input.id), null);
    assert.equal(await repository.findJob(other, input.jobId), null);
    await assert.rejects(repository.createDraft(other, jobDraft(ownerId)), /JOB_OWNER_MISMATCH/);
    const row = await db.jobVersion.findFirstOrThrow({ where: { ownerId, id: input.id } });
    const foreignId = randomUUID(), duplicateId = randomUUID();
    await assert.rejects(db.jobVersion.create({ data: { ...row, id: foreignId, ownerId: other, version: 2,
      document: { ...input.document, sourceVersionId: foreignId }, dimensionWeights: input.dimensionWeights } }));
    await assert.rejects(db.jobVersion.create({ data: { ...row, id: duplicateId,
      document: { ...input.document, sourceVersionId: duplicateId }, dimensionWeights: input.dimensionWeights } }));
    await assert.rejects(db.jobRequirement.updateMany({ where: { ownerId, jobVersionId: input.id }, data: { ownerId: other } }));
    await assert.rejects(db.jobVersion.update({ where: { ownerId, id: input.id }, data: { version: 2 } }));
  });
  await t.test('transaction failure leaves no partial job or version', async () => {
    const failed = jobDraft(ownerId);
    await assert.rejects(db.$transaction(async tx => {
      await tx.job.create({ data: { id: failed.jobId, ownerId } });
      await tx.jobVersion.create({ data: { id: failed.id, ownerId, jobId: failed.jobId, version: 0,
        title: failed.title, skills: [], document: failed.document, dimensionWeights: failed.dimensionWeights } });
    }));
    assert.equal(await repository.findJob(ownerId, failed.jobId), null);
    assert.equal(await repository.findVersion(ownerId, failed.id), null);
    const invalid = jobDraft(ownerId);
    invalid.requirements[0]!.sourceRef.quote = '造假的测试';
    await assert.rejects(repository.createDraft(ownerId, invalid));
    assert.equal(await repository.findJob(ownerId, invalid.jobId), null);
  });
  await t.test('published content and requirements reject UPDATE, INSERT and individual DELETE', async () => {
    await publish(input.id);
    await assert.rejects(db.jobVersion.update({ where: { ownerId, id: input.id }, data: { title: '替换内容' } }));
    await assert.rejects(db.jobVersion.update({ where: { ownerId, id: input.id }, data: { status: 'DRAFT' } }));
    await assert.rejects(db.jobRequirement.updateMany({ where: { ownerId, jobVersionId: input.id }, data: { ordinal: 2 } }));
    await assert.rejects(db.jobRequirement.deleteMany({ where: { ownerId, jobVersionId: input.id } }));
    await assert.rejects(db.jobRequirement.create({ data: { ownerId, jobVersionId: input.id, stableId: 'late', ordinal: 1,
      requirement: { ...input.requirements[0]!, stableId: 'late' } } }));
    assert.equal((await repository.findVersion(ownerId, input.id))?.requirements.length, 1);
  });
  await t.test('a requirement writer queued behind publication cannot change the published version', async () => {
    const draft = jobDraft(ownerId); await repository.createDraft(ownerId, draft);
    const connection = await database.pool.connect();
    let writer: Promise<boolean> | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM job_version WHERE owner_id=$1::uuid AND id=$2::uuid FOR UPDATE', [ownerId, draft.id]);
      const pid = z.array(z.object({ pid: z.number() })).length(1).parse((await connection.query('SELECT pg_backend_pid() AS pid')).rows)[0]!.pid;
      writer = db.jobRequirement.create({ data: { ownerId, jobVersionId: draft.id, stableId: 'concurrent', ordinal: 1,
        requirement: { ...draft.requirements[0]!, stableId: 'concurrent' } } }).then(() => false, () => true);
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const result = await database.pool.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND $1::int=ANY(pg_blocking_pids(pid))', [pid]);
        blocked = z.array(z.object({ count: z.number() })).length(1).parse(result.rows)[0]!.count > 0;
        if (blocked) break;
        await delay(20);
      }
      assert.equal(blocked, true, 'Observe the actual writer waiting on the publication lock');
      await connection.query("UPDATE job_version SET status='PUBLISHED', published_at=now(), content_hash=$3, index_status='PENDING', hard_requirements_confirmed=true, weights_confirmed=true WHERE owner_id=$1::uuid AND id=$2::uuid", [ownerId, draft.id, 'b'.repeat(64)]);
      await connection.query('COMMIT'); assert.equal(await writer, true);
      assert.equal((await repository.findVersion(ownerId, draft.id))?.requirements.length, 1);
    } finally { await connection.query('ROLLBACK'); connection.release(); await writer; }
  });
  await t.test('rubric content is schema validated, owner scoped, hashed and immutable', async () => {
    const rubric = syntheticRubric(); await repository.insertRubric(ownerId, rubric);
    assert.deepEqual((await repository.findRubric(ownerId, rubric.version))?.content, rubric);
    assert.equal(await repository.findRubric(other, rubric.version), null);
    await assert.rejects(repository.insertRubric(ownerId, { ...rubric, dimensions: [] }));
    await assert.rejects(db.rubricVersion.update({ where: { ownerId_version: { ownerId, version: rubric.version } }, data: { contentHash: 'b'.repeat(64) } }));
  });
  await t.test('real tasks bind owner and published version while synthetic UUIDs remain compatible', async () => {
    const synthetic = await new TaskRepository(database).createJobIndex(randomUUID(), { ...jobIndexInput(), ownerId });
    const row = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: synthetic.taskId } });
    assert.equal(row.realJobVersionId, null);
    const snapshot = jobIndexInputSnapshotSchema.parse({ ...jobIndexInputSnapshotSchema.parse(row.inputSnapshot), kind: 'job-index', ownerId,
      jobVersionId: input.id, contentHash: input.document.textHash });
    const real = { ...row, id: randomUUID(), idempotencyKey: randomUUID(), jobVersionId: input.id,
      realJobVersionId: input.id, inputSnapshot: snapshot, budgetUsage: budgetUsageSchema.parse(row.budgetUsage) };
    await assert.rejects(db.jobIndexTask.create({ data: { ...real, realJobVersionId: null } }));
    await assert.rejects(db.jobIndexTask.create({ data: { ...real, realJobVersionId: randomUUID() } }));
    await assert.rejects(db.jobIndexTask.create({ data: { ...real, ownerId: other, inputSnapshot: { ...snapshot, ownerId: other } } }));
    await db.jobIndexTask.create({ data: real });
    await assert.rejects(db.jobIndexTask.update({ where: { id: real.id, ownerId }, data: { realJobVersionId: null } }));
    const store = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
    const message = taskDispatchSchema.parse({ schemaVersion: 1, taskType: 'job-index', taskId: real.id,
      messageId: randomUUID(), dispatchGeneration: 1, occurredAt: new Date().toISOString() });
    assert.deepEqual(await store.claim(ownerId, message), { kind: 'deferred' });
    await db.jobIndexTask.update({ where: { id: real.id, ownerId }, data: { updatedAt: new Date(0) } });
    assert.equal(await store.reconcile(ownerId, 'job-index', real.id, reconciliationConfigSchema.parse({})), 'handler-unavailable');
    const pending = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: real.id } });
    assert.equal(pending.status, 'QUEUED'); assert.equal(budgetUsageSchema.parse(pending.budgetUsage).attempts, 0);
    assert.equal(await db.consumerReceipt.count({ where: { ownerId, taskId: real.id } }), 0);
    await db.jobIndexTask.update({ where: { id: real.id, ownerId }, data: { cancelRequested: true } });
    assert.deepEqual(await store.claim(ownerId, message), { kind: 'ack' });
    assert.equal((await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: real.id } })).status, 'CANCELLED');
  });
});
