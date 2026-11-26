import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connect } from 'amqplib';
import type { Channel, GetMessage } from 'amqplib';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { taskTopology, declareTaskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { installTaskPolicy } from '../../src/infrastructure/messaging/task-topology.admin.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import type { SyntheticTaskHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { QuarantineStore } from '../../src/infrastructure/consumer/quarantine.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { TaskFailure } from '../../src/infrastructure/consumer/failure.js';
import { OutboxStore } from '../../src/infrastructure/outbox/outbox.store.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox.publisher.js';
import { outboxConfigSchema } from '../../src/infrastructure/outbox/config.js';
import { taskDispatchSchema, deadMessageSchema, budgetUsageSchema, quarantineMetadataSchema } from '../../src/contracts/tasks.js';
import type { TaskType } from '../../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';

async function receive(channel: Channel, queue: string): Promise<GetMessage> {
  const until = Date.now() + 5_000;
  do { const message = await channel.get(queue, { noAck: false }); if (message) return message; await delay(50); } while (Date.now() < until);
  throw new Error('Expected synthetic message missing');
}

await test('S1.4-T5 transactional retry, cumulative budgets, dead outbox and quarantine', { timeout: 180_000 }, async t => {
  await ownedPostgres(); await ownedRabbit();
  const config = loadInfrastructureConfig(process.env), database = new DatabaseService(config), db = database.client;
  const topology = taskTopology(`s12.t5.${randomUUID().replaceAll('-', '')}`);
  const queues = [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead];
  const connection = await connect(config.rabbitmqUrl, { timeout: 5_000 }); connection.on('error', () => {});
  const channel = await connection.createChannel(); channel.on('error', () => {});
  const owners: string[] = [];
  mkdirSync('data/s15-runs', { recursive: true });
  const manifest = `data/s15-runs/${topology.namespace}.json`;
  const saveManifest = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ namespace: topology.namespace, queues, ownerIds: owners, cleaned }, null, 2));
  saveManifest();
  const listed = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin(['list_queues','-p','resume-studio-s12-test','name','--formatter','json']));
  assert.ok(queues.every(name => !listed.some(item => item.name === name)));
  t.after(async () => {
    try {
      await ownedRabbit(); await ownedPostgres();
      // Cleanup owns a fresh connection: failure of the observation channel must not prevent cleanup.
      const cleanupConnection = await connect(config.rabbitmqUrl, { timeout: 5_000 }); cleanupConnection.on('error', () => {});
      try {
        const cleanup = await cleanupConnection.createChannel(); cleanup.on('error', () => {});
        for (const queue of queues) await cleanup.deleteQueue(queue);
        await cleanup.deleteExchange(topology.exchange); await cleanup.deleteExchange(topology.deadExchange);
      } finally { await cleanupConnection.close(); }
      await rabbitAdmin(['clear_policy','-p','resume-studio-s12-test',topology.policy]);
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where: { ownerId } }); await tx.taskEvent.deleteMany({ where: { ownerId } });
          await tx.taskAttempt.deleteMany({ where: { ownerId } }); await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.quarantine.deleteMany({ where: { ownerId } }); await tx.analysisTask.deleteMany({ where: { ownerId } });
          await tx.jobIndexTask.deleteMany({ where: { ownerId } }); await tx.owner.delete({ where: { id: ownerId } });
        });
        for (const count of await Promise.all([db.owner.count({ where: { id: ownerId } }), db.outboxEvent.count({ where: { ownerId } }),
          db.quarantine.count({ where: { ownerId } }), db.consumerReceipt.count({ where: { ownerId } }), db.taskEvent.count({ where: { ownerId } }),
          db.taskAttempt.count({ where: { ownerId } }), db.analysisTask.count({ where: { ownerId } }), db.jobIndexTask.count({ where: { ownerId } })])) assert.equal(count, 0);
      }
      const remaining = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin(['list_queues','-p','resume-studio-s12-test','name','--formatter','json']));
      assert.ok(remaining.every(item => !queues.includes(item.name)));
      saveManifest(true);
      t.diagnostic('T5 exact-run database/queue/policy residuals 0; no raw payload persisted');
    } finally { await channel.close().catch(() => {}); await connection.close().catch(() => {}); await database.onModuleDestroy(); assert.equal(database.pool.totalCount, 0); }
  });
  t.afterEach(async () => {
    for (const queue of queues) for (let index = 0; index < 20; index++) {
      const message = await channel.get(queue, { noAck: false }); if (!message) break; channel.ack(message);
    }
  });
  await installTaskPolicy(topology); await declareTaskTopology(channel, topology);
  const publisher = new ConfirmedTaskPublisher(config.rabbitmqUrl, topology, 5_000);
  const executionConfig = consumerConfigSchema.parse({ heartbeatMs: 100, leaseMs: 2_000 });
  // Use the real transaction and actual SQL constraint failure, without a cold Nest container
  // or a type assertion between Prisma's incompatible extended-client generic declarations.
  const brokenOutbox: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== 'outboxEvent') return Reflect.get(target, key, receiver);
      return new Proxy(target.outboxEvent, { get(model, method, modelReceiver) {
        if (method !== 'create') return Reflect.get(model, method, modelReceiver);
        return (args: Prisma.OutboxEventCreateArgs) => model.create({ ...args, data: { ...args.data, payloadVersion: 0 } });
      } });
    },
  }))) } };
  async function context(type: TaskType, budget: Partial<ReturnType<typeof analysisInput>['budget']> = {}) {
    const ownerId = randomUUID(); await db.owner.create({ data: { id: ownerId } }); owners.push(ownerId); saveManifest();
    const identity = { getOwnerId: () => Promise.resolve(ownerId) };
    const tasks = new TaskCreationService(identity, new TaskRepository(database));
    const input = type === 'analysis' ? analysisInput() : jobIndexInput();
    input.budget = { ...input.budget, maxDurationMs: 300_000, ...budget };
    const task = type === 'analysis' ? await tasks.createAnalysis(randomUUID(), input) : await tasks.createJobIndex(randomUUID(), input);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: task.taskId } });
    const message = taskDispatchSchema.parse(event.payload);
    const store = new TaskExecutionStore(database, executionConfig), quarantine = new QuarantineStore(database, identity);
    const handler = (executor: SyntheticTaskHandler = new SyntheticCompletionHandler(), persistence = store) => new TaskDeliveryHandler(persistence, identity, executor, executionConfig);
    const consumer = (executor?: SyntheticTaskHandler, persistence?: TaskExecutionStore, q = quarantine) =>
      new TaskConsumer(config.rabbitmqUrl, topology, handler(executor, persistence), q);
    const outbox = new OutboxPublisher(new OutboxStore(database, outboxConfigSchema.parse({})), publisher, identity, outboxConfigSchema.parse({}));
    const read = () => type === 'analysis' ? db.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: task.taskId } } })
      : db.jobIndexTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: task.taskId } } });
    // The initial Outbox is also published through the production publisher.
    assert.equal(await outbox.runOnce(), 'published');
    return { ownerId, identity, taskId: task.taskId, message, store, handler, consumer, outbox, read, quarantine,
      queue: type === 'analysis' ? topology.analysis : topology.jobIndex, deadQueue: type === 'analysis' ? topology.analysisDead : topology.jobIndexDead };
  }
  async function forceDue(ownerId: string, taskId: string, type: TaskType) {
    // Test only: move this run's scheduling timestamps; assert real no-early-publish first.
    await db.outboxEvent.updateMany({ where: { ownerId, aggregateId: taskId, publishedAt: null }, data: { availableAt: new Date(0) } });
    const table = type === 'analysis' ? 'analysis_task' : 'job_index_task';
    await database.pool.query(`UPDATE ${table} SET retry_at = now() - interval '1 second' WHERE owner_id=$1::uuid AND id=$2::uuid`, [ownerId, taskId]);
  }
  async function consumeDead(queue: string) {
    const delivery = await receive(channel, queue), payload = deadMessageSchema.parse(JSON.parse(delivery.content.toString()) as unknown);
    assert.equal(delivery.properties.messageId, payload.messageId); channel.ack(delivery); await channel.checkQueue(queue); return payload;
  }
  const transient: SyntheticTaskHandler = { execute: () => Promise.reject(new TaskFailure('RATE_LIMITED')) };
  const permanent: SyntheticTaskHandler = { execute: () => Promise.reject(new TaskFailure('INPUT_INVALID')) };

  for (const type of ['analysis','job-index'] as const) {
    await t.test(`${type}: retry transfers atomically, defers until due, changes message/generation and exhausts to dead`, async () => {
      const c = await context(type, { maxAttempts: 2 });
      assert.equal((await c.consumer(transient).run(type, { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      let task = await c.read(); assert.equal(task.status, 'RETRY_WAIT'); assert.equal(task.generation, 2); assert.ok(task.retryAt);
      const frozen = task.inputSnapshot;
      const retry = await db.outboxEvent.findFirstOrThrow({ where: { ownerId: c.ownerId, publishedAt: null } });
      const retryMessage = taskDispatchSchema.parse(retry.payload);
      assert.notEqual(retryMessage.messageId, c.message.messageId); assert.equal(retryMessage.taskId, c.taskId); assert.equal(retryMessage.dispatchGeneration, 2);
      assert.equal(retry.availableAt.getTime(), task.retryAt.getTime());
      assert.equal((await db.consumerReceipt.findFirstOrThrow({ where: { ownerId: c.ownerId, messageId: c.message.messageId } })).status, 'DONE');
      assert.equal(await c.outbox.runOnce(), 'idle');
      assert.equal((await c.store.claim(c.ownerId, retryMessage)).kind, 'deferred');
      await publisher.publish(c.message);
      assert.equal((await c.consumer({ execute: () => { assert.fail('Old generation executed'); } }).run(type, { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      await forceDue(c.ownerId, c.taskId, type); assert.equal(await c.outbox.runOnce(), 'published');
      assert.equal((await c.consumer(transient).run(type, { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      task = await c.read(); assert.equal(task.status, 'FAILED'); assert.equal(task.errorCode, 'BUDGET_EXHAUSTED'); assert.deepEqual(task.inputSnapshot, frozen);
      assert.equal(budgetUsageSchema.parse(task.budgetUsage).attempts, 2); assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 2);
      assert.equal(await c.outbox.runOnce(), 'published'); const dead = await consumeDead(c.deadQueue);
      assert.equal(dead.errorCode, 'BUDGET_EXHAUSTED'); assert.equal(dead.source.kind, 'task');
      assert.equal(await c.outbox.runOnce(), 'idle');
      await publisher.publish(retryMessage); assert.equal((await c.consumer().run(type, { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId, eventType: { endsWith: '.dead.v1' } } }), 1);
    });
  }

  await t.test('token/cost/call reservations survive retry and prevent external work past cumulative budget', async () => {
    for (const dimension of ['modelCalls','tokens','costMicros'] as const) {
      const c = await context('analysis', { maxModelCalls: dimension === 'modelCalls' ? 1 : 10,
        maxTokens: dimension === 'tokens' ? 60 : 1000, maxCostMicros: dimension === 'costMicros' ? 70 : 1000 });
      let externalCalls = 0;
      const executor: SyntheticTaskHandler = { execute: async (_claim, _signal, budget) => {
        await budget.reserve({ modelCalls: 1, tokens: 60, costMicros: 70 }); externalCalls++;
        throw new TaskFailure('UPSTREAM_TIMEOUT');
      } };
      assert.equal((await c.consumer(executor).run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      await forceDue(c.ownerId, c.taskId, 'analysis'); assert.equal(await c.outbox.runOnce(), 'published');
      assert.equal((await c.consumer(executor).run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      assert.equal(externalCalls, 1); const task = await c.read(); assert.equal(task.status, 'FAILED'); assert.equal(task.errorCode, 'BUDGET_EXHAUSTED');
      const usage = budgetUsageSchema.parse(task.budgetUsage);
      assert.equal(usage.modelCalls, 1); assert.equal(usage.tokens, 60); assert.equal(usage.costMicros, 70); assert.equal(usage.attempts, 2);
      const attempts = await db.taskAttempt.findMany({ where: { ownerId: c.ownerId } });
      assert.equal(attempts.reduce((sum, attempt) => sum + attempt.tokens, 0n), 60n);
      assert.equal(attempts.reduce((sum, attempt) => sum + attempt.costMicros, 0n), 70n);
    }
  });

  await t.test('permanent and unknown errors become safe FAILED/dead without leaking raw details', async () => {
    for (const executor of [permanent, { execute: () => Promise.reject(new Error('synthetic-secret@example.invalid token=private')) }]) {
      const c = await context('job-index');
      assert.equal((await c.consumer(executor).run('job-index', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      assert.equal((await c.read()).status, 'FAILED'); assert.equal(await c.outbox.runOnce(), 'published');
      const dead = await consumeDead(c.deadQueue);
      assert.ok(['INPUT_INVALID','EXECUTION_FAILED'].includes(dead.errorCode));
      assert.ok(!JSON.stringify(dead).includes('private')); assert.ok(!JSON.stringify(dead).includes('@'));
    }
  });

  await t.test('total deadline bounds delays, runtime timeout and recovery of an exhausted final attempt', async () => {
    const short = await context('analysis', { maxDurationMs: 10_000 });
    assert.equal((await short.consumer(transient).run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
    assert.equal((await short.read()).errorCode, 'DEADLINE_EXCEEDED'); // retry cannot fit before frozen deadline
    const runtime = await context('analysis', { maxDurationMs: 500 });
    const result = await runtime.consumer({ execute: async (claim, signal) => {
      await delay(2000, undefined, { signal }); return new SyntheticCompletionHandler().execute(claim, signal);
    } }).run('analysis', { maxMessages: 1, windowMs: 8_000 });
    assert.equal(result.acknowledged, 1); assert.equal((await runtime.read()).errorCode, 'DEADLINE_EXCEEDED');
    const last = await context('analysis', { maxAttempts: 1 });
    const message = await receive(channel, last.queue); channel.ack(message);
    const claim = await last.store.claim(last.ownerId, last.message); assert.equal(claim.kind, 'acquired');
    await db.analysisTask.update({ where: { ownerId_id: { ownerId: last.ownerId, id: last.taskId } }, data: { leaseUntil: new Date(0) } });
    assert.equal((await last.store.claim(last.ownerId, last.message)).kind, 'ack');
    assert.equal((await last.read()).status, 'FAILED'); assert.equal(await db.taskAttempt.count({ where: { ownerId: last.ownerId } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { ownerId: last.ownerId, eventType: 'analysis.dead.v1' } }), 1);
    if (claim.kind === 'acquired') await assert.rejects(last.store.fail(claim.claim, new TaskFailure('INPUT_INVALID')));
  });

  await t.test('dead return keeps durable pending event and task FAILED until a confirmed dead publish', async () => {
    const c = await context('analysis');
    assert.equal((await c.consumer(permanent).run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
    await channel.unbindQueue(c.deadQueue, topology.deadExchange, 'analysis.dead.v1');
    try {
      assert.equal(await c.outbox.runOnce(), 'failed');
      const pending = await db.outboxEvent.findFirstOrThrow({ where: { ownerId: c.ownerId, eventType: 'analysis.dead.v1' } });
      assert.equal(pending.publishedAt, null); assert.equal(pending.lastErrorCode, 'UNROUTABLE'); assert.equal((await c.read()).status, 'FAILED');
      await channel.bindQueue(c.deadQueue, topology.deadExchange, 'analysis.dead.v1');
      await db.outboxEvent.update({ where: { eventId: pending.eventId, ownerId: c.ownerId }, data: { availableAt: new Date(0) } });
      assert.equal(await c.outbox.runOnce(), 'published');
      assert.equal((await consumeDead(c.deadQueue)).messageId, pending.eventId);
    } finally { await channel.bindQueue(c.deadQueue, topology.deadExchange, 'analysis.dead.v1'); }
  });

  await t.test('retry/dead outbox SQL failure rolls back status/receipt/event and leaves original message unACKed', async () => {
    for (const executor of [transient, permanent]) {
      const c = await context('analysis');
      {
        const store = new TaskExecutionStore(brokenOutbox, executionConfig);
        const outcome = await c.consumer(executor, store).run('analysis', { maxMessages: 1, windowMs: 8_000 });
        assert.equal(outcome.acknowledged, 0); assert.equal(outcome.reason, 'error');
        assert.equal((await c.read()).status, 'RUNNING'); assert.equal((await c.read()).generation, 1);
        assert.equal((await db.consumerReceipt.findFirstOrThrow({ where: { ownerId: c.ownerId } })).status, 'RUNNING');
        assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0); assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId } }), 1);
        const redelivery = await receive(channel, c.queue); assert.equal(redelivery.fields.redelivered, true); channel.ack(redelivery);
      }
    }
  });

  const rawMarker = 'synthetic-secret@example.invalid password=private';
  async function publishMalformed() {
    const confirm = await connection.createConfirmChannel(); confirm.on('error', () => {});
    try { await new Promise<void>((resolve, reject) => confirm.publish(topology.exchange, 'analysis.requested.v1', Buffer.from(`{invalid ${rawMarker}`),
      { contentType: 'application/json', messageId: 'invalid-secret-header', persistent: true }, error => error ? reject(error) : resolve())); }
    finally { await confirm.close(); }
  }
  async function discardInitial(c: Awaited<ReturnType<typeof context>>) { const delivery = await receive(channel, c.queue); channel.ack(delivery); await channel.checkQueue(c.queue); }

  await t.test('malformed and unknown deliveries are quarantined idempotently with a minimal real dead message', async () => {
    const c = await context('analysis'); await discardInitial(c);
    await publishMalformed(); await publishMalformed();
    assert.equal((await c.consumer().run('analysis', { maxMessages: 2, windowMs: 8_000 })).acknowledged, 2);
    const records = await db.quarantine.findMany({ where: { ownerId: c.ownerId } }); assert.equal(records.length, 1);
    const record = records[0]!; quarantineMetadataSchema.parse(record.safeMetadata);
    assert.equal(record.messageId, null); assert.equal(record.errorCode, 'MALFORMED_MESSAGE');
    assert.ok(!JSON.stringify(record).includes(rawMarker)); assert.ok(!JSON.stringify(record).includes('invalid-secret-header'));
    assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId, aggregateType: 'Quarantine' } }), 1);
    assert.equal(await c.outbox.runOnce(), 'published'); const dead = await consumeDead(c.deadQueue);
    assert.equal(dead.source.kind, 'quarantine'); assert.ok(!JSON.stringify(dead).includes(rawMarker));
    const unknown = { ...c.message, messageId: randomUUID(), taskId: randomUUID() };
    await publisher.publish(unknown);
    assert.equal((await c.consumer().run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
    assert.equal(await db.quarantine.count({ where: { ownerId: c.ownerId, errorCode: 'TASK_NOT_AVAILABLE' } }), 1);
    assert.equal((await c.read()).status, 'QUEUED');
  });

  await t.test('quarantine dead event failure rolls back isolation row; read-only DB never ACKs malformed input', async () => {
    const c = await context('analysis'); await discardInitial(c);
    {
      await publishMalformed();
      assert.equal((await c.consumer(undefined, undefined, new QuarantineStore(brokenOutbox, c.identity))
        .run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 0);
      assert.equal(await db.quarantine.count({ where: { ownerId: c.ownerId } }), 0);
      assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId } }), 1);
      const url = new URL(config.databaseUrl); url.searchParams.set('options', '-c default_transaction_read_only=on');
      const readOnly = new DatabaseService({ databaseUrl: url.toString() });
      try { assert.equal((await c.consumer(undefined, undefined, new QuarantineStore(readOnly, c.identity))
        .run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 0); }
      finally { await readOnly.onModuleDestroy(); }
      assert.equal((await c.consumer().run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
      assert.equal(await db.quarantine.count({ where: { ownerId: c.ownerId } }), 1);
    }
  });

  await t.test('concurrent isolation of the same poison delivery creates one quarantine and one dead event', async () => {
    const c = await context('analysis'); await discardInitial(c); await publishMalformed();
    const delivery = await receive(channel, c.queue);
    // A consume delivery's additional consumerTag is irrelevant to quarantine persistence.
    const envelope = { ...delivery, fields: { ...delivery.fields, consumerTag: 'synthetic-concurrent' } };
    await Promise.all([c.quarantine.persist(envelope, 'analysis', 'MALFORMED_MESSAGE'), c.quarantine.persist(envelope, 'analysis', 'MALFORMED_MESSAGE')]);
    channel.ack(delivery); await channel.checkQueue(c.queue);
    assert.equal(await db.quarantine.count({ where: { ownerId: c.ownerId } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId, aggregateType: 'Quarantine' } }), 1);
  });

  for (const mode of ['retry','dead','quarantine'] as const) {
    await t.test(`${mode} durable handoff followed by process kill before ACK is safe on redelivery`, async () => {
      const c = await context('analysis');
      if (mode === 'quarantine') { await discardInitial(c); await publishMalformed(); }
      const child = fork(new URL('./retry-crash.fixture.js', import.meta.url), [], { silent: true,
        env: { ...process.env, S15_OWNER_ID: c.ownerId, S15_NAMESPACE: topology.namespace, S15_MODE: mode } });
      child.stdout?.resume(); child.stderr?.resume(); const exit = once(child, 'exit');
      try {
        const response = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error('Child exited before handoff'); }),
          delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Handoff IPC timeout'); })]);
        assert.deepEqual(response[0], { type: 'handoff-before-ack', mode });
        child.kill('SIGKILL'); await exit;
        assert.equal((await c.consumer({ execute: () => { assert.fail('Committed handoff re-executed'); } })
          .run('analysis', { maxMessages: 1, windowMs: 8_000 })).acknowledged, 1);
        assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId } }), 2);
        if (mode === 'quarantine') assert.equal(await db.quarantine.count({ where: { ownerId: c.ownerId } }), 1);
        else {
          assert.equal((await c.read()).status, mode === 'retry' ? 'RETRY_WAIT' : 'FAILED');
          assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 1);
        }
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
    });
  }
});
