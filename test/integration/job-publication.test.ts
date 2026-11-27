import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { GetMessage } from 'amqplib';
import { connect } from 'amqplib';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { taskTopology, declareTaskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { installTaskPolicy } from '../../src/infrastructure/messaging/task-topology.admin.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobPublicationService } from '../../src/modules/jobs/job-publication.service.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox.publisher.js';
import { OutboxStore } from '../../src/infrastructure/outbox/outbox.store.js';
import { outboxConfigSchema } from '../../src/infrastructure/outbox/config.js';
import { jobIndexInputSnapshotSchema, taskDispatchSchema } from '../../src/contracts/tasks.js';
import { jobDraft } from '../support/job-inputs.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';
import { IdempotencyConflictError } from '../../src/modules/tasks/task-errors.js';
import type { ExecutionClaim } from '../../src/infrastructure/consumer/contracts.js';

await test('S2.2 publication is atomic and idempotent, real broker delivery stays pending and old targets are fenced', { timeout: 120_000 }, async t => {
  await ownedPostgres(); await ownedRabbit();
  const config = loadInfrastructureConfig(process.env), database = new DatabaseService(config), db = database.client;
  const topology = taskTopology(`s12.t4.${randomUUID().replaceAll('-', '')}`);
  const connection = await connect(config.rabbitmqUrl, { timeout: 5000 }); connection.on('error', () => {});
  const channel = await connection.createChannel(); channel.on('error', () => {});
  const queues = [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead], owners: string[] = [];
  mkdirSync('data/s22-publication-runs', { recursive: true });
  const manifest = `data/s22-publication-runs/${topology.namespace}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ namespace: topology.namespace, queues, ownerIds: owners, cleaned }, null, 2));
  save();
  t.after(async () => {
    try {
      await ownedPostgres(); await ownedRabbit();
      for (const queue of queues) await channel.deleteQueue(queue);
      await channel.deleteExchange(topology.exchange); await channel.deleteExchange(topology.deadExchange);
      await rabbitAdmin(['clear_policy', '-p', 'resume-studio-s12-test', topology.policy]);
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where: { ownerId } }); await tx.taskEvent.deleteMany({ where: { ownerId } });
          await tx.taskAttempt.deleteMany({ where: { ownerId } }); await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.jobIndexTarget.deleteMany({ where: { ownerId } }); await tx.jobIndexTask.deleteMany({ where: { ownerId } });
          await tx.jobVersion.deleteMany({ where: { ownerId } }); await tx.job.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        assert.equal(await db.jobVersion.count({ where: { ownerId } }), 0);
      }
      save(true);
      t.diagnostic('T4 exact-run queues/policy/jobs/tasks/outbox/targets/owners removed');
    } finally { await channel.close(); await connection.close(); await database.onModuleDestroy(); }
  });
  await installTaskPolicy(topology); await declareTaskTopology(channel, topology);
  for (const id of [randomUUID(), randomUUID()]) { await db.owner.create({ data: { id } }); owners.push(id); save(); }
  const ownerId = owners[0]!, identity = { getOwnerId: () => Promise.resolve(ownerId) };
  const repository = new JobRepository(database), publications = new JobPublicationRepository(database);
  // Explicit test-only target; no embedding or official index is claimed by these tests.
  const target = jobIndexTargetSchema.parse({ embeddingVersion: 'fixture-only-v1', indexVersion: 'fixture-only-v1',
    chunkerVersion: 'fixture-only-v1', componentVersion: 'fixture-only-v1', budget: { maxAttempts: 3, maxModelCalls: 0,
      maxTokens: 0, maxCostMicros: 0, currency: 'CNY', maxDurationMs: 30_000 } });
  const service = new JobPublicationService(identity, publications, target);
  const input = jobDraft(ownerId); await repository.createDraft(ownerId, input);
  const key = randomUUID();
  await t.test('confirmation and configured target are required; failures preserve the draft', async () => {
    await assert.rejects(service.publish(input.id, key), /JOB_NOT_CONFIRMED/);
    await service.confirm(input.id, { hardRequirementsConfirmed: true, weightsConfirmed: false });
    await assert.rejects(service.publish(input.id, key), /JOB_NOT_CONFIRMED/);
    await service.confirm(input.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
    await assert.rejects(new JobPublicationService(identity, publications, undefined).publish(input.id, key), /JOB_INDEX_TARGET_UNAVAILABLE/);
    assert.equal((await repository.findVersion(ownerId, input.id))?.status, 'DRAFT');
    assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 0);
    assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 0);
  });
  await t.test('Outbox SQL failure rolls back publication, task and target; same key can retry', async () => {
    const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
      get(current, name, receiver) {
        if (name !== 'outboxEvent') return Reflect.get(current, name, receiver);
        return new Proxy(current.outboxEvent, { get(model, method, modelReceiver) {
          if (method !== 'create') return Reflect.get(model, method, modelReceiver);
          return (args: Prisma.OutboxEventCreateArgs) => model.create({ ...args, data: { ...args.data, payloadVersion: 0 } });
        } });
      },
    }))) } };
    await assert.rejects(new JobPublicationService(identity, new JobPublicationRepository(broken), target).publish(input.id, key));
    assert.equal((await repository.findVersion(ownerId, input.id))?.status, 'DRAFT');
    assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 0);
    assert.equal(await db.jobIndexTarget.count({ where: { ownerId } }), 0);
    assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 0);
  });
  const [published, replay] = await Promise.all([service.publish(input.id, key), service.publish(input.id, key)]);
  await t.test('concurrent same request returns one version/task; conflicting request and foreign owner fail', async () => {
    assert.deepEqual(published, replay);
    assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 1);
    assert.equal((await repository.findVersion(ownerId, input.id))?.status, 'PUBLISHED');
    await assert.rejects(service.publish(randomUUID(), key), IdempotencyConflictError);
    await assert.rejects(new JobPublicationService({ getOwnerId: () => Promise.resolve(owners[1]!) }, publications, target)
      .publish(input.id, randomUUID()), /JOB_NOT_FOUND/);
    assert.deepEqual(await new JobPublicationService(identity, publications, { ...target, indexVersion: 'future-v2' }).publish(input.id, key), published);
  });
  await t.test('real RabbitMQ publication carries only dispatch identity and synthetic consumer does not ACK or mark READY', async () => {
    const outboxConfig = outboxConfigSchema.parse({});
    const publisher = new OutboxPublisher(new OutboxStore(database, outboxConfig),
      new ConfirmedTaskPublisher(config.rabbitmqUrl, topology, 5000), identity, outboxConfig);
    assert.equal(await publisher.runOnce(), 'published');
    const consumerConfig = consumerConfigSchema.parse({});
    const consumer = new TaskConsumer(config.rabbitmqUrl, topology,
      new TaskDeliveryHandler(new TaskExecutionStore(database, consumerConfig), identity, new SyntheticCompletionHandler(),
        consumerConfig, new PostgresExecutionLock(database.pool)));
    const result = await consumer.run('job-index', { maxMessages: 1, windowMs: 8000 });
    assert.equal(result.acknowledged, 0); assert.equal(result.reason, 'deferred');
    // Socket closure requests redelivery but is not a broker-side requeue barrier.
    let delivery: GetMessage | false = false;
    const redeliveryDeadline = Date.now() + 5000;
    while (!delivery && Date.now() < redeliveryDeadline) {
      delivery = await channel.get(topology.jobIndex, { noAck: false });
      if (!delivery) await delay(50);
    }
    assert.ok(delivery);
    const message = taskDispatchSchema.parse(JSON.parse(delivery.content.toString()) as unknown);
    assert.equal(message.taskId, published.taskId); assert.equal(delivery.fields.redelivered, true);
    channel.ack(delivery); await channel.checkQueue(topology.jobIndex);
    assert.equal((await repository.findVersion(ownerId, input.id))?.indexStatus, 'PENDING');
    const task = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: published.taskId } });
    assert.equal(jobIndexInputSnapshotSchema.parse(task.inputSnapshot).kind, 'job-index');
    assert.equal(task.status, 'QUEUED'); assert.equal(await db.taskAttempt.count({ where: { ownerId } }), 0);
  });
  await t.test('ready commit checks actual task fence, target and version; old input cannot mark a new version ready', async () => {
    const execution = new TaskExecutionStore(database, consumerConfigSchema.parse({ leaseMs: 10_000, heartbeatMs: 1000 }));
    const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: published.taskId } });
    const message = taskDispatchSchema.parse(event.payload);
    const claimed = await execution.claim(ownerId, message, 'job-index'); assert.equal(claimed.kind, 'acquired');
    if (claimed.kind !== 'acquired') assert.fail('Claim required');
    const claim = claimed.claim;
    const draft = await repository.editDraft(ownerId, input.id, { kind: 'metadata', metadata: { title: '新版', city: null, level: null, skills: [] } });
    await service.confirm(draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
    const newer = await service.publish(draft.id, randomUUID());
    const redirected: ExecutionClaim = { ...claim, snapshot: jobIndexInputSnapshotSchema.parse({ ...claim.snapshot,
      jobVersionId: draft.id, contentHash: draft.document.textHash }) };
    await assert.rejects(execution.markJobIndexReady(redirected), /TASK_EXECUTION_LEASE_LOST/);
    assert.equal((await repository.findVersion(ownerId, draft.id))?.indexStatus, 'PENDING');
    await db.jobIndexTask.update({ where: { ownerId, id: published.taskId }, data: { leaseUntil: new Date(0) } });
    const takeover = await execution.claim(ownerId, message, 'job-index'); assert.equal(takeover.kind, 'acquired');
    if (takeover.kind !== 'acquired') assert.fail('Takeover required');
    await assert.rejects(execution.markJobIndexReady(claim), /TASK_EXECUTION_LEASE_LOST/);
    await execution.markJobIndexReady(takeover.claim); // storage/fencing test only, no vector or semantic claim
    assert.equal((await repository.findVersion(ownerId, input.id))?.indexStatus, 'READY');
    assert.equal((await repository.findVersion(ownerId, newer.jobVersionId))?.indexStatus, 'PENDING');
    const previous = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: published.taskId } });
    const nextSnapshot = jobIndexInputSnapshotSchema.parse({ ...jobIndexInputSnapshotSchema.parse(previous.inputSnapshot), indexVersion: 'fixture-target-v2' });
    const replacementId = randomUUID();
    await db.jobIndexTask.create({ data: { id: replacementId, ownerId, jobVersionId: input.id, realJobVersionId: input.id,
      embeddingVersion: nextSnapshot.embeddingVersion, indexVersion: nextSnapshot.indexVersion, inputSnapshot: nextSnapshot,
      idempotencyKey: randomUUID(), requestHash: 'c'.repeat(64), budgetUsage: { schemaVersion: 1, attempts: 0, modelCalls: 0, tokens: 0, costMicros: 0, elapsedMs: 0 },
    } });
    await db.$transaction(async tx => {
      await tx.jobVersion.update({ where: { ownerId, id: input.id }, data: { indexStatus: 'PENDING' } });
      await tx.jobIndexTarget.update({ where: { ownerId, jobVersionId: input.id }, data: { taskId: replacementId, indexVersion: nextSnapshot.indexVersion } });
    });
    await assert.rejects(execution.markJobIndexReady(takeover.claim), /TASK_EXECUTION_LEASE_LOST/);
    assert.equal((await repository.findVersion(ownerId, input.id))?.indexStatus, 'PENDING');
  });
});
