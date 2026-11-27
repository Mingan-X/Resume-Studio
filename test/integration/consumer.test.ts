import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { connect } from 'amqplib';
import type { Channel, GetMessage } from 'amqplib';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { taskTopology, declareTaskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { installTaskPolicy } from '../../src/infrastructure/messaging/task-topology.admin.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import type { SyntheticTaskHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import type { TaskType } from '../../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';
import { networkFaultProxy } from '../support/network-fault-proxy.js';

async function receive(channel: Channel, queue: string): Promise<GetMessage> {
  const until = Date.now() + 5_000;
  do { const message = await channel.get(queue, { noAck: false }); if (message) return message; await delay(50); } while (Date.now() < until);
  throw new Error('Expected unacknowledged message to be redelivered');
}

await test('S1.4-T4 real consumer receipts, execution leases and fenced completion', { timeout: 180_000 }, async t => {
  await ownedPostgres(); await ownedRabbit();
  const connectionConfig = loadInfrastructureConfig(process.env), database = new DatabaseService(connectionConfig), db = database.client;
  const topology = taskTopology(`s12.t4.${randomUUID().replaceAll('-', '')}`);
  const queues = [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead];
  const connection = await connect(connectionConfig.rabbitmqUrl, { timeout: 5_000 }); connection.on('error', () => {});
  const channel = await connection.createChannel(); channel.on('error', () => {});
  const owners: string[] = [];
  const existing = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin(['list_queues', '-p', 'resume-studio-s12-test', 'name', '--formatter', 'json']));
  assert.ok(queues.every(name => !existing.some(queue => queue.name === name)));
  t.after(async () => {
    try {
      await ownedRabbit(); await ownedPostgres();
      for (const queue of queues) await channel.deleteQueue(queue);
      await channel.deleteExchange(topology.exchange); await channel.deleteExchange(topology.deadExchange);
      await rabbitAdmin(['clear_policy', '-p', 'resume-studio-s12-test', topology.policy]);
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where: { ownerId } }); await tx.taskEvent.deleteMany({ where: { ownerId } });
          await tx.taskAttempt.deleteMany({ where: { ownerId } }); await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.analysisTask.deleteMany({ where: { ownerId } }); await tx.jobIndexTask.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        for (const count of await Promise.all([db.consumerReceipt.count({ where: { ownerId } }), db.taskEvent.count({ where: { ownerId } }),
          db.taskAttempt.count({ where: { ownerId } }), db.outboxEvent.count({ where: { ownerId } }), db.analysisTask.count({ where: { ownerId } }),
          db.jobIndexTask.count({ where: { ownerId } }), db.owner.count({ where: { id: ownerId } })])) assert.equal(count, 0);
      }
      const remaining = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin(['list_queues', '-p', 'resume-studio-s12-test', 'name', '--formatter', 'json']));
      assert.ok(remaining.every(queue => !queues.includes(queue.name)));
      t.diagnostic('T4 exact-run tasks/attempts/events/receipts/outbox/owners/queues/policy removed; DB pool drained');
    } finally { await channel.close().catch(() => {}); await connection.close().catch(() => {}); await database.onModuleDestroy(); assert.equal(database.pool.totalCount, 0); }
  });
  t.afterEach(async () => {
    // These exact queues were absent before this test run. Prevent a failing case contaminating the next.
    for (const queue of queues) for (let index = 0; index < 10; index++) {
      const message = await channel.get(queue, { noAck: false }); if (!message) break; channel.ack(message);
    }
  });
  await installTaskPolicy(topology); await declareTaskTopology(channel, topology);
  const publisher = new ConfirmedTaskPublisher(connectionConfig.rabbitmqUrl, topology, 5_000);
  async function context(type: TaskType) {
    const ownerId = randomUUID(); await db.owner.create({ data: { id: ownerId } }); owners.push(ownerId);
    const identity = { getOwnerId: () => Promise.resolve(ownerId) };
    const tasks = new TaskCreationService(identity, new TaskRepository(database));
    const input = type === 'analysis' ? analysisInput() : jobIndexInput();
    input.budget.maxDurationMs = 60_000;
    const task = type === 'analysis' ? await tasks.createAnalysis(randomUUID(), input) : await tasks.createJobIndex(randomUUID(), input);
    const row = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: task.taskId } });
    const message = taskDispatchSchema.parse(row.payload), config = consumerConfigSchema.parse({ heartbeatMs: 100, leaseMs: 2_000 });
    const store = new TaskExecutionStore(database, config);
    const handler = (execution: SyntheticTaskHandler = new SyntheticCompletionHandler(), persistence = store) =>
      new TaskDeliveryHandler(persistence, identity, execution, config, new PostgresExecutionLock(database.pool));
    const consumer = (execution?: SyntheticTaskHandler, persistence?: TaskExecutionStore) =>
      new TaskConsumer(connectionConfig.rabbitmqUrl, topology, handler(execution, persistence));
    const read = () => type === 'analysis' ? db.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: task.taskId } } })
      : db.jobIndexTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: task.taskId } } });
    return { ownerId, taskId: task.taskId, message, identity, config, store, handler, consumer, read,
      queue: type === 'analysis' ? topology.analysis : topology.jobIndex };
  }

  await t.test('S3.3 PostgreSQL transport unavailable leaves delivery unACKed and recovers from the same persisted input', async () => {
    const c = await context('analysis'), proxy = await networkFaultProxy(55432);
    const url = new URL(connectionConfig.databaseUrl); url.port = String(proxy.port);
    const unavailable = new DatabaseService({ ...connectionConfig, databaseUrl: url.toString() });
    try {
      await unavailable.check(); proxy.block();
      const handler = new TaskDeliveryHandler(new TaskExecutionStore(unavailable, c.config), c.identity,
        new SyntheticCompletionHandler(), c.config, new PostgresExecutionLock(unavailable.pool));
      await publisher.publish(c.message);
      const failed = await new TaskConsumer(connectionConfig.rabbitmqUrl, topology, handler)
        .run('analysis', { maxMessages: 1, windowMs: 10_000 });
      assert.equal(failed.received, 1); assert.equal(failed.acknowledged, 0); assert.equal(failed.reason, 'error');
      assert.equal((await c.read()).status, 'QUEUED');
      const redelivery = await receive(channel, c.queue);
      assert.equal(redelivery.fields.redelivered, true); assert.equal(redelivery.properties.messageId, c.message.messageId);
      channel.nack(redelivery, false, true); await channel.checkQueue(c.queue);
      proxy.unblock(); await unavailable.check();
      const recovered = await c.consumer().run('analysis', { maxMessages: 1, windowMs: 10_000 });
      assert.equal(recovered.acknowledged, 1); assert.equal((await c.read()).status, 'SUCCEEDED');
      assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 1);
    } finally { await unavailable.onModuleDestroy(); await proxy.close(); }
  });

  for (const type of ['analysis', 'job-index'] as const) {
    await t.test(`${type}: duplicate deliveries produce one attempt/completion and durable DONE receipt before ACK`, async () => {
      const c = await context(type); let executed = 0;
      await publisher.publish(c.message); await publisher.publish(c.message);
      const result = await c.consumer({ execute: (claim, signal) => { executed++; return new SyntheticCompletionHandler().execute(claim, signal); } })
        .run(type, { maxMessages: 2, windowMs: 10_000 });
      assert.equal(result.acknowledged, 2); assert.equal(result.reason, 'limit'); assert.equal(executed, 1);
      const row = await c.read(); assert.equal(row.status, 'SUCCEEDED'); assert.equal(row.fenceToken, 1n); assert.equal(row.leaseOwner, null);
      assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 1);
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId, stage: 'SYNTHETIC_COMPLETED' } }), 1);
      const receipt = await db.consumerReceipt.findFirstOrThrow({ where: { ownerId: c.ownerId, messageId: c.message.messageId } });
      assert.equal(receipt.status, 'DONE'); assert.ok(receipt.processedAt); assert.equal(receipt.leaseOwner, null);
    });

    await t.test(`${type}: concurrent claims defer duplicate work, takeover increments fence and rejects old heartbeat/output`, async () => {
      const c = await context(type);
      const results = await Promise.all([c.store.claim(c.ownerId, c.message), c.store.claim(c.ownerId, c.message)]);
      const first = results.find(result => result.kind === 'acquired'); assert.ok(first?.kind === 'acquired');
      assert.equal(results.filter(result => result.kind === 'deferred').length, 1);
      // This claim is made directly, without TaskDeliveryHandler's heartbeat loop.
      // Keep it live while publishing/connecting; a 2s expired lease correctly permits takeover.
      const live = new AbortController();
      let heartbeatError: unknown;
      const heartbeat = (async () => {
        while (!live.signal.aborted) {
          await c.store.heartbeat(first.claim);
          await delay(c.config.heartbeatMs, undefined, { signal: live.signal }).catch(error => {
            if (!live.signal.aborted) throw error;
          });
        }
      })().catch(error => { heartbeatError = error; });
      try {
      await publisher.publish(c.message);
      const deferred = await c.consumer().run(type, { maxMessages: 1, windowMs: 5_000 });
      assert.equal(deferred.reason, 'deferred'); assert.equal(deferred.acknowledged, 0);
      } finally { live.abort(); await heartbeat; }
      assert.equal(heartbeatError, undefined);
      const delivery = await receive(channel, c.queue); assert.equal(delivery.fields.redelivered, true); channel.ack(delivery);
      const table = type === 'analysis' ? 'analysis_task' : 'job_index_task';
      await database.pool.query(`UPDATE ${table} SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id=$1::uuid AND id=$2::uuid`, [c.ownerId, c.taskId]);
      const next = await c.store.claim(c.ownerId, c.message); assert.equal(next.kind, 'acquired'); if (next.kind !== 'acquired') return;
      assert.equal(next.claim.fenceToken, first.claim.fenceToken + 1n);
      await assert.rejects(c.store.heartbeat(first.claim), /LEASE_LOST/);
      await assert.rejects(c.store.complete(first.claim, await new SyntheticCompletionHandler().execute(first.claim, new AbortController().signal)), /LEASE_LOST/);
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0);
      await c.store.complete(next.claim, await new SyntheticCompletionHandler().execute(next.claim, new AbortController().signal));
      assert.equal((await c.read()).status, 'SUCCEEDED');
      await assert.rejects(c.store.complete(first.claim, await new SyntheticCompletionHandler().execute(first.claim, new AbortController().signal)));
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 1);
      assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 2);
      await assert.rejects(database.pool.query(`UPDATE ${table} SET fence_token=0 WHERE owner_id=$1::uuid AND id=$2::uuid`, [c.ownerId, c.taskId]), { code: '23514' });
      await assert.rejects(database.pool.query(`UPDATE ${table} SET status='RUNNING' WHERE owner_id=$1::uuid AND id=$2::uuid`, [c.ownerId, c.taskId]), { code: '23514' });
    });
  }

  await t.test('two live consumers share duplicate delivery without duplicate output', async () => {
    const c = await context('analysis'); let executions = 0;
    const handler: SyntheticTaskHandler = { execute: async (claim, signal) => {
      executions++; await delay(400, undefined, { signal });
      return new SyntheticCompletionHandler().execute(claim, signal);
    } };
    await publisher.publish(c.message); await publisher.publish(c.message);
    const results = await Promise.all([c.consumer(handler).run('analysis', { maxMessages: 1, windowMs: 8_000 }),
      c.consumer(handler).run('analysis', { maxMessages: 1, windowMs: 8_000 })]);
    assert.equal(executions, 1);
    assert.ok(results.some(result => result.acknowledged === 1));
    assert.ok(results.every(result => ['limit', 'deferred'].includes(result.reason)));
    if (results.some(result => result.reason === 'deferred')) {
      assert.equal((await c.consumer(handler).run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
    }
    assert.equal(executions, 1); assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 1);
  });

  await t.test('heartbeat extends matching task and receipt, then ownership loss aborts work without ACK', async () => {
    const c = await context('analysis'); let renewals = 0;
    let firstHeartbeat!: () => void;
    const renewed = new Promise<void>(resolve => { firstHeartbeat = resolve; });
    class ObservedStore extends TaskExecutionStore {
      override async heartbeat(claim: Parameters<TaskExecutionStore['heartbeat']>[0]) {
        await super.heartbeat(claim); renewals++; firstHeartbeat();
      }
    }
    const store = new ObservedStore(database, c.config);
    await publisher.publish(c.message);
    const outcome = await c.consumer({ execute: async (claim, signal) => {
        // Synchronize on an actual heartbeat instead of guessing its completion after 350ms.
        // Both rows must come from one snapshot while later heartbeats continue updating them.
        await Promise.race([renewed, delay(2000, undefined, { signal }).then(() => { throw new Error('Expected heartbeat'); })]);
        const { task, receipt } = await db.$transaction(async tx => ({
          task: await tx.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId: c.ownerId, id: c.taskId } } }),
          receipt: await tx.consumerReceipt.findFirstOrThrow({ where: { ownerId: c.ownerId } }),
        }), { isolationLevel: 'RepeatableRead' });
      assert.ok(task.heartbeatAt && task.heartbeatAt > claim.startedAt);
      assert.equal(task.leaseUntil?.getTime(), receipt.leaseUntil?.getTime());
      await db.analysisTask.update({ where: { ownerId_id: { ownerId: c.ownerId, id: c.taskId } }, data: { fenceToken: { increment: 1 } } });
      await delay(2_000, undefined, { signal });
      return new SyntheticCompletionHandler().execute(claim, signal);
    } }, store).run('analysis', { maxMessages: 1, windowMs: 8_000 });
    assert.ok(renewals >= 1); assert.equal(outcome.acknowledged, 0); assert.equal(outcome.reason, 'error');
    const requeued = await receive(channel, c.queue); assert.equal(requeued.fields.redelivered, true); channel.ack(requeued);
    assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0);
    assert.equal((await c.read()).status, 'RUNNING');
  });

  await t.test('stale generation and terminal tasks ACK without execution; future/foreign/reused IDs fail closed', async () => {
    const c = await context('analysis');
    await db.analysisTask.update({ where: { ownerId_id: { ownerId: c.ownerId, id: c.taskId } }, data: { generation: 2 } });
    await publisher.publish(c.message);
    const never: SyntheticTaskHandler = { execute: () => { assert.fail('Stale task executed'); } };
    assert.equal((await c.consumer(never).run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
    assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 0);
    await assert.rejects(c.store.claim(c.ownerId, { ...c.message, dispatchGeneration: 3, messageId: randomUUID() }), /FUTURE/);
    await assert.rejects(c.store.claim(randomUUID(), c.message), /TASK_NOT_AVAILABLE/);
    await assert.rejects(c.store.claim(c.ownerId, { ...c.message, dispatchGeneration: 2 }), /MESSAGE_ID_REUSED/);
    await db.analysisTask.update({ where: { ownerId_id: { ownerId: c.ownerId, id: c.taskId } }, data: { status: 'CANCELLED' } });
    await publisher.publish({ ...c.message, messageId: randomUUID(), dispatchGeneration: 2 });
    assert.equal((await c.consumer(never).run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
    assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0);
  });

  await t.test('read-only PostgreSQL rejects receipt writes, no ACK; normal redelivery can finish', async () => {
    const c = await context('analysis'), url = new URL(connectionConfig.databaseUrl);
    url.searchParams.set('options', '-c default_transaction_read_only=on');
    const readOnly = new DatabaseService({ databaseUrl: url.toString() });
    try {
      await readOnly.check();
      await publisher.publish(c.message);
      const result = await c.consumer(undefined, new TaskExecutionStore(readOnly, c.config)).run('analysis', { maxMessages: 1, windowMs: 5_000 });
      assert.equal(result.reason, 'error'); assert.equal(result.acknowledged, 0);
      assert.equal((await c.read()).status, 'QUEUED'); assert.equal(await db.consumerReceipt.count({ where: { ownerId: c.ownerId } }), 0);
      assert.equal((await c.consumer().run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
      // A completed task must still not ACK while its DONE disposition cannot be written.
      await publisher.publish(c.message);
      assert.equal((await c.consumer(undefined, new TaskExecutionStore(readOnly, c.config)).run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 0);
      assert.equal((await c.consumer().run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 1);
    } finally { await readOnly.onModuleDestroy(); }
  });

  await t.test('SQL failure writing completion rolls back terminal state and DONE receipt; retry produces one event', async () => {
    const c = await context('job-index');
    const client = db.$extends({ query: { taskEvent: { create: ({ args, query }) =>
      query({ ...args, data: { ...args.data, stage: 'x'.repeat(65) } }) } } });
    const testingModule = await Test.createTestingModule({ providers: [{ provide: DatabaseService, useValue: { client } }] }).compile();
    try {
      const faulty = new TaskExecutionStore(testingModule.get(DatabaseService), c.config);
      await publisher.publish(c.message);
      const result = await c.consumer(undefined, faulty).run('job-index', { maxMessages: 1, windowMs: 5_000 });
      assert.equal(result.acknowledged, 0); assert.equal(result.reason, 'error');
      assert.equal((await c.read()).status, 'RUNNING');
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0);
      assert.equal((await db.consumerReceipt.findFirstOrThrow({ where: { ownerId: c.ownerId } })).status, 'RUNNING');
      await db.jobIndexTask.update({ where: { ownerId_id: { ownerId: c.ownerId, id: c.taskId } }, data: { leaseUntil: new Date(0) } });
      assert.equal((await c.consumer().run('job-index', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 1);
    } finally { await testingModule.close(); }
  });

  await t.test('commit then process kill before ACK redelivers to terminal task without repeated output', async () => {
    const c = await context('analysis'); await publisher.publish(c.message);
    const child = fork(new URL('./consumer-crash.fixture.js', import.meta.url), [], { silent: true,
      env: { ...process.env, S14_OWNER_ID: c.ownerId, S14_NAMESPACE: topology.namespace } });
    child.stdout?.resume(); child.stderr?.resume(); const exit = once(child, 'exit');
    try {
      const response = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error('Consumer exited before IPC'); }),
        delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Consumer IPC timeout'); })]);
      assert.deepEqual(response[0], { type: 'committed-before-ack' }); assert.equal((await c.read()).status, 'SUCCEEDED');
      child.kill('SIGKILL'); await exit;
      assert.equal((await c.consumer({ execute: () => { assert.fail('Committed task repeated'); } })
        .run('analysis', { maxMessages: 1, windowMs: 5_000 })).acknowledged, 1);
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 1);
      assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 1);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
  });

  await t.test('session shutdown and malformed payload do not ACK or hot-loop', async () => {
    const c = await context('analysis'); await publisher.publish(c.message);
    const abort = new AbortController();
    const result = await c.consumer({ execute: async (claim, signal) => {
      abort.abort(); await delay(100, undefined, { signal }); return new SyntheticCompletionHandler().execute(claim, signal);
    } }).run('analysis', { maxMessages: 1, windowMs: 5_000 }, abort.signal);
    assert.equal(result.reason, 'stopped'); assert.equal(result.acknowledged, 0);
    const delivery = await receive(channel, c.queue); assert.equal(delivery.fields.redelivered, true); channel.ack(delivery);
    assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0);
    const confirm = await connection.createConfirmChannel(); confirm.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => confirm.publish(topology.exchange, 'analysis.requested.v1', Buffer.from('{bad'),
        { contentType: 'application/json', messageId: randomUUID(), persistent: true }, error => error ? reject(error) : resolve()));
      const malformed = await c.consumer().run('analysis', { maxMessages: 1, windowMs: 5_000 });
      assert.equal(malformed.reason, 'error'); assert.equal(malformed.received, 1); assert.equal(malformed.acknowledged, 0);
      const requeued = await receive(channel, c.queue); assert.equal(requeued.fields.redelivered, true); channel.ack(requeued);
    } finally { await confirm.close(); }
  });
});
