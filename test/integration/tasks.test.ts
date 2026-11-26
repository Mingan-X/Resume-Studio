import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TasksModule } from '../../src/modules/tasks/tasks.module.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { IdempotencyConflictError } from '../../src/modules/tasks/task-errors.js';
import { IDENTITY, DEVELOPMENT_OWNER_ID } from '../../src/modules/identity/identity.module.js';
import {
  analysisInputSnapshotSchema, jobIndexInputSnapshotSchema, taskDispatchSchema,
  taskCountsSchema, quarantineMetadataSchema, budgetUsageSchema,
} from '../../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';

await test('S1.4 real PostgreSQL task creation, ownership, concurrency and rollback', { timeout: 120_000 }, async t => {
  await ownedPostgres();
  const ownerId = randomUUID(), otherOwnerId = randomUUID();
  const module = await Test.createTestingModule({
    imports: [TasksModule.register(loadInfrastructureConfig(process.env))],
  }).overrideProvider(IDENTITY).useValue({ getOwnerId: () => Promise.resolve(ownerId) }).compile();
  await module.init();
  const database = module.get(DatabaseService), db = database.client;
  const service = module.get(TaskCreationService);
  const createdOwners: string[] = [];
  const quarantines: string[] = [];
  t.after(async () => {
    try {
      await ownedPostgres();
      // These exact owners were successfully inserted by this run. No prefix/global cleanup.
      for (const id of createdOwners) {
        const where = { ownerId: id };
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where });
          await tx.taskEvent.deleteMany({ where });
          await tx.taskAttempt.deleteMany({ where });
          await tx.outboxEvent.deleteMany({ where });
          await tx.analysisTask.deleteMany({ where });
          await tx.jobIndexTask.deleteMany({ where });
          await tx.owner.delete({ where: { id } });
        });
        for (const count of await Promise.all([
          db.analysisTask.count({ where }), db.jobIndexTask.count({ where }),
          db.outboxEvent.count({ where }), db.taskAttempt.count({ where }),
          db.taskEvent.count({ where }), db.consumerReceipt.count({ where }),
          db.owner.count({ where: { id } }),
        ])) assert.equal(count, 0);
      }
      for (const id of quarantines) {
        await db.quarantine.delete({ where: { id } });
        assert.equal(await db.quarantine.count({ where: { id } }), 0);
      }
      t.diagnostic('S1.4 exact-run owner/task/outbox/attempt/event/receipt/quarantine residuals: 0');
    } finally {
      await module.close();
      assert.equal(database.pool.totalCount, 0);
    }
  });
  for (const id of [ownerId, otherOwnerId]) {
    await db.owner.create({ data: { id } });
    createdOwners.push(id);
  }
  assert.ok(await db.owner.findUnique({ where: { id: DEVELOPMENT_OWNER_ID } }));

  // Extensions still issue real SQL through the same bounded pool/interactive transactions.
  async function usingClient(client: unknown, owner: string, work: (tasks: TaskCreationService) => Promise<void>) {
    const context = await Test.createTestingModule({ providers: [
      TaskCreationService, TaskRepository,
      { provide: IDENTITY, useValue: { getOwnerId: () => Promise.resolve(owner) } },
      { provide: DatabaseService, useValue: { client } },
    ] }).compile();
    try { await work(context.get(TaskCreationService)); }
    finally { await context.close(); }
  }

  const analysis = analysisInput(), jobIndex = jobIndexInput();
  const key = randomUUID();
  const initialAnalysis = await service.createAnalysis(key, analysis);
  const initialJobIndex = await service.createJobIndex(key, jobIndex);

  await t.test('S2.2 real snapshot persistence remains closed until the T2 business FK migration', async () => {
    const snapshot = jobIndexInputSnapshotSchema.parse({ ...jobIndexInput(), ownerId, kind: 'job-index' });
    const key = randomUUID(), before = await db.outboxEvent.count({ where: { ownerId } });
    await assert.rejects(module.get(TaskRepository).createJobIndex(key, snapshot));
    assert.equal(await db.jobIndexTask.count({ where: { ownerId, idempotencyKey: key } }), 0);
    assert.equal(await db.outboxEvent.count({ where: { ownerId } }), before);
  });

  await t.test('separate task defaults, immutable version snapshots and minimal transactional outbox', async () => {
    const a = await db.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: initialAnalysis.taskId } } });
    const j = await db.jobIndexTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: initialJobIndex.taskId } } });
    assert.equal(a.status, 'QUEUED'); assert.equal(j.status, 'QUEUED');
    assert.equal(a.generation, 1); assert.equal(j.generation, 1);
    assert.equal(a.fenceToken, 0n); assert.equal(j.fenceToken, 0n);
    assert.equal(a.activeGraphThreadId, a.id); assert.equal(a.graphGeneration, 1);
    assert.equal(a.cancelRequested, false); assert.equal(j.cancelRequested, false);
    assert.deepEqual(analysisInputSnapshotSchema.parse(a.inputSnapshot), { ...analysis, ownerId });
    assert.deepEqual(jobIndexInputSnapshotSchema.parse(j.inputSnapshot), { ...jobIndex, ownerId });
    for (const [result, aggregateType, eventType] of [
      [initialAnalysis, 'AnalysisTask', 'analysis.requested.v1'],
      [initialJobIndex, 'JobIndexTask', 'job.index.requested.v1'],
    ] as const) {
      const events = await db.outboxEvent.findMany({ where: { ownerId, aggregateId: result.taskId, aggregateType } });
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.equal(event.eventType, eventType); assert.equal(event.publishedAt, null);
      assert.equal(event.publishAttempts, 0); assert.equal(event.payloadVersion, 1);
      const payload = taskDispatchSchema.parse(event.payload);
      assert.equal(payload.messageId, event.eventId);
      assert.equal(payload.taskId, result.taskId); assert.equal(payload.taskType, result.taskType);
      assert.equal(payload.dispatchGeneration, 1);
      assert.deepEqual(Object.keys(payload).sort(), [
        'schemaVersion', 'messageId', 'taskType', 'taskId', 'dispatchGeneration', 'occurredAt',
      ].sort());
    }
  });

  await t.test('same key replays, different values conflict, owner/type scopes are independent', async () => {
    const reordered = Object.fromEntries(Object.entries(analysis).reverse());
    assert.deepEqual(await service.createAnalysis(key.toUpperCase(), reordered), initialAnalysis);
    assert.deepEqual(await service.createJobIndex(key, jobIndex), initialJobIndex);
    await assert.rejects(service.createAnalysis(key, { ...analysis, rubricVersion: 'synthetic-v2' }),
      error => error instanceof IdempotencyConflictError && error.statusCode === 409);
    await assert.rejects(service.createJobIndex(key, { ...jobIndex, indexVersion: 'synthetic-v2' }), IdempotencyConflictError);
    // A new service instance (process-local cache cannot satisfy this assertion).
    await usingClient(db, ownerId, async tasks => {
      assert.deepEqual(await tasks.createAnalysis(key, analysis), initialAnalysis);
    });
    await usingClient(db, otherOwnerId, async tasks => {
      const a = await tasks.createAnalysis(key, analysis), j = await tasks.createJobIndex(key, jobIndex);
      assert.notEqual(a.taskId, initialAnalysis.taskId); assert.notEqual(j.taskId, initialJobIndex.taskId);
    });
    assert.equal(await db.analysisTask.findUnique({
      where: { ownerId_id: { ownerId: otherOwnerId, id: initialAnalysis.taskId } },
    }), null);
    assert.equal(await db.jobIndexTask.findUnique({
      where: { ownerId_id: { ownerId: otherOwnerId, id: initialJobIndex.taskId } },
    }), null);
  });

  for (const kind of ['analysis', 'job-index'] as const) {
    for (const conflicting of [false, true]) {
      await t.test(`${kind}: concurrent ${conflicting ? 'different' : 'same'} requests resolve against one committed winner`, async () => {
        // Barrier after BOTH real SELECTs return absent guarantees an insert race.
        let arrived = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Concurrent SELECT barrier timed out')), 3_000);
          release = () => { clearTimeout(timer); resolve(); };
        });
        const raceKey = randomUUID();
        const concurrent = db.$extends({ query: { $allModels: {
          async findUnique({ model, args, query }) {
            const result = await query(args);
            if ((model === 'AnalysisTask' || model === 'JobIndexTask') && result === null) {
              arrived++;
              if (arrived === 2) release();
              await barrier;
            }
            return result;
          },
        } } });
        await usingClient(concurrent, ownerId, async tasks => {
          const requests = kind === 'analysis'
            ? [tasks.createAnalysis(raceKey, analysis), tasks.createAnalysis(raceKey,
              conflicting ? { ...analysis, scoringVersion: 'synthetic-v2' } : analysis)]
            : [tasks.createJobIndex(raceKey, jobIndex), tasks.createJobIndex(raceKey,
              conflicting ? { ...jobIndex, indexVersion: 'synthetic-v2' } : jobIndex)];
          const results = await Promise.allSettled(requests);
          assert.equal(arrived, 2);
          const successes = results.filter(result => result.status === 'fulfilled');
          const failures = results.filter(result => result.status === 'rejected');
          assert.equal(successes.length, conflicting ? 1 : 2);
          assert.equal(failures.length, conflicting ? 1 : 0);
          for (const failure of failures) assert.ok(failure.reason instanceof IdempotencyConflictError);
          assert.equal(new Set(successes.map(result => result.value.taskId)).size, 1);
          const taskId = successes[0]!.value.taskId;
          const where = { ownerId, idempotencyKey: raceKey };
          assert.equal(kind === 'analysis' ? await db.analysisTask.count({ where }) : await db.jobIndexTask.count({ where }), 1);
          assert.equal(await db.outboxEvent.count({ where: { ownerId, aggregateId: taskId } }), 1);
        });
      });
    }
  }

  await t.test('outbox failure before/after INSERT rolls back both task types and permits same-key retry', async () => {
    for (const kind of ['analysis', 'job-index'] as const) {
      for (const afterInsert of [false, true]) {
        const rollbackKey = randomUUID();
        const before = await db.outboxEvent.count({ where: { ownerId } });
        let observed = false;
        const fault = db.$extends({ query: { outboxEvent: {
          async create({ args, query }) {
            if (afterInsert) await query(args);
            observed = true;
            throw new Error('synthetic-outbox-failure');
          },
        } } });
        await usingClient(fault, ownerId, async tasks => {
          await assert.rejects(kind === 'analysis'
            ? tasks.createAnalysis(rollbackKey, analysis) : tasks.createJobIndex(rollbackKey, jobIndex),
          /synthetic-outbox-failure/);
        });
        assert.equal(observed, true);
        const where = { ownerId, idempotencyKey: rollbackKey };
        assert.equal(await db.analysisTask.count({ where }), 0);
        assert.equal(await db.jobIndexTask.count({ where }), 0);
        assert.equal(await db.outboxEvent.count({ where: { ownerId } }), before);
        const retried = kind === 'analysis'
          ? await service.createAnalysis(rollbackKey, analysis) : await service.createJobIndex(rollbackKey, jobIndex);
        assert.equal(await db.outboxEvent.count({ where: { ownerId, aggregateId: retried.taskId } }), 1);
      }
    }
  });

  await t.test('unregistered identities cannot insert tasks or outbox', async () => {
    const missingOwner = randomUUID();
    await usingClient(db, missingOwner, async tasks => {
      await assert.rejects(tasks.createAnalysis(randomUUID(), analysis), { code: 'P2003' });
      await assert.rejects(tasks.createJobIndex(randomUUID(), jobIndex), { code: 'P2003' });
    });
    assert.equal(await db.outboxEvent.count({ where: { ownerId: missingOwner } }), 0);
  });

  await t.test('database rejects mutable inputs, malformed states, negative generation and inconsistent owner/version', async () => {
    // Use pg directly to assert SQLSTATE rather than relying on adapter-specific error wrapping.
    const taskIds = [initialAnalysis.taskId, initialJobIndex.taskId];
    for (const [index, table] of ['analysis_task', 'job_index_task'].entries()) {
      for (const assignment of [
        "input_snapshot = input_snapshot || '{\"schemaVersion\":2}'::jsonb",
        "request_hash = repeat('c', 64)",
        'idempotency_key = gen_random_uuid()',
        'owner_id = gen_random_uuid()',
        'generation = 0', 'fence_token = -1',
        'lease_owner = gen_random_uuid()',
      ]) {
        await assert.rejects(database.pool.query(
          `UPDATE "${table}" SET ${assignment} WHERE owner_id = $1::uuid AND id = $2::uuid`, [ownerId, taskIds[index]],
        ), { code: '23514' });
      }
      await assert.rejects(database.pool.query(
        `UPDATE "${table}" SET status = 'INVALID' WHERE owner_id = $1::uuid AND id = $2::uuid`, [ownerId, taskIds[index]],
      ), { code: '22P02' });
    }
    await assert.rejects(database.pool.query(
      "UPDATE job_index_task SET status = 'PARTIAL' WHERE owner_id = $1::uuid AND id = $2::uuid", [ownerId, initialJobIndex.taskId],
    ), { code: '22P02' });
    // Allowed non-input field updates still work; this migration does not implement T4 transitions.
    await db.analysisTask.update({ where: { ownerId_id: { ownerId, id: initialAnalysis.taskId } }, data: { stage: 'SYNTHETIC' } });
    const row = await db.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: initialAnalysis.taskId } } });
    const stored = { ...row, inputSnapshot: analysisInputSnapshotSchema.parse(row.inputSnapshot),
      budgetUsage: budgetUsageSchema.parse(row.budgetUsage) };
    await assert.rejects(db.analysisTask.create({ data: {
      ...stored, id: randomUUID(), idempotencyKey: randomUUID(),
      inputSnapshot: analysisInputSnapshotSchema.parse({ ...analysis, ownerId: otherOwnerId }),
    } }));
    await assert.rejects(db.analysisTask.create({ data: {
      ...stored, id: randomUUID(), idempotencyKey: randomUUID(), resumeVersionId: randomUUID(),
    } }));
    await assert.rejects(db.analysisTask.create({ data: { ...stored, id: randomUUID() } }), { code: 'P2002' });
  });

  await t.test('attempt/event/receipt FKs bind task type and owner; sequences and message receipts are unique', async () => {
    const reference = {
      ownerId, taskType: 'ANALYSIS' as const, taskId: initialAnalysis.taskId, analysisTaskId: initialAnalysis.taskId,
    };
    const counts = taskCountsSchema.parse({ schemaVersion: 1, planned: 1, completed: 0, failed: 0 });
    const event = { ...reference, id: randomUUID(), seq: 1, stage: 'QUEUED', counts, safeMessage: 'Synthetic task accepted' };
    await db.taskEvent.create({ data: event });
    await assert.rejects(db.taskEvent.create({ data: { ...event, id: randomUUID() } }), { code: 'P2002' });
    await assert.rejects(db.taskEvent.create({ data: { ...event, id: randomUUID(), seq: 2, ownerId: otherOwnerId } }), { code: 'P2003' });
    await assert.rejects(db.taskEvent.create({ data: { ...event, id: randomUUID(), seq: 2, taskId: randomUUID() } }));
    await assert.rejects(db.taskEvent.create({ data: { ...event, id: randomUUID(), seq: 2, jobIndexTaskId: initialJobIndex.taskId } }));
    await assert.rejects(db.taskEvent.create({ data: { ...event, id: randomUUID(), seq: 2, analysisTaskId: null } }));
    await db.taskEvent.create({ data: { ...event, id: randomUUID(), seq: 2 } });
    const events = await db.taskEvent.findMany({ where: { ownerId, taskId: initialAnalysis.taskId }, orderBy: { seq: 'asc' } });
    assert.deepEqual(events.map(item => item.seq), [1, 2]);

    const attempt = { ...reference, attemptId: randomUUID(), generation: 1, fenceToken: 0n, currency: 'USD' };
    await db.taskAttempt.create({ data: attempt });
    await assert.rejects(db.taskAttempt.create({ data: { ...attempt, attemptId: randomUUID(), ownerId: otherOwnerId } }), { code: 'P2003' });
    await assert.rejects(db.taskAttempt.create({ data: { ...attempt, attemptId: randomUUID(), taskType: 'JOB_INDEX' } }));
    await db.taskAttempt.create({ data: { ...attempt, attemptId: randomUUID(), generation: 2, fenceToken: 1n } });
    assert.equal(await db.taskAttempt.count({ where: { ownerId, taskId: initialAnalysis.taskId } }), 2);

    const receipt = { ...reference, id: randomUUID(), consumerName: 'synthetic', messageId: randomUUID(), generation: 1 };
    await db.consumerReceipt.create({ data: receipt });
    await assert.rejects(db.consumerReceipt.create({ data: { ...receipt, id: randomUUID() } }), { code: 'P2002' });
    await assert.rejects(db.consumerReceipt.create({ data: { ...receipt, id: randomUUID(), messageId: randomUUID(), ownerId: otherOwnerId } }), { code: 'P2003' });
    await assert.rejects(db.consumerReceipt.create({ data: { ...receipt, id: randomUUID(), messageId: randomUUID(), status: 'DONE' } }));
    await db.consumerReceipt.update({ where: { id: receipt.id, ownerId }, data: { status: 'DONE', processedAt: new Date() } });
    // Job-index relations are equally real, rather than optional dangling polymorphic IDs.
    const jobReference = { ownerId, taskType: 'JOB_INDEX' as const, taskId: initialJobIndex.taskId,
      analysisTaskId: null, jobIndexTaskId: initialJobIndex.taskId };
    await db.taskEvent.create({ data: { ...event, ...jobReference, id: randomUUID() } });
    await db.taskAttempt.create({ data: { ...attempt, ...jobReference, attemptId: randomUUID() } });
    await db.consumerReceipt.create({ data: { ...receipt, ...jobReference, id: randomUUID(), messageId: randomUUID() } });
    const id = randomUUID();
    await db.quarantine.create({ data: {
      id, messageHash: 'a'.repeat(64), errorCode: 'MALFORMED_MESSAGE',
      safeMetadata: quarantineMetadataSchema.parse({ schemaVersion: 1, byteLength: 1, source: 'unknown' }),
    } });
    quarantines.push(id);
    const quarantined = await db.quarantine.findUniqueOrThrow({ where: { id } });
    assert.equal(quarantined.messageId, null);
    quarantineMetadataSchema.parse(quarantined.safeMetadata);
    const constraints = await database.pool.query(
      "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid IN ('task_attempt'::regclass, 'task_event'::regclass, 'consumer_receipt'::regclass) AND contype = 'f'",
    );
    assert.equal(z.array(z.object({ count: z.number() })).parse(constraints.rows)[0]?.count, 6);
  });
});
