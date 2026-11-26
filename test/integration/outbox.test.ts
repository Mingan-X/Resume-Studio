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
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { installTaskPolicy } from '../../src/infrastructure/messaging/task-topology.admin.js';
import { taskTopology, declareTaskTopology, taskPolicy } from '../../src/infrastructure/messaging/task-topology.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { outboxConfigSchema } from '../../src/infrastructure/outbox/config.js';
import { OutboxStore } from '../../src/infrastructure/outbox/outbox.store.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox.publisher.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';
import { amqpFaultProxy } from '../support/amqp-proxy.js';

async function receive(channel: Channel, queue: string, timeoutMs = 5_000): Promise<GetMessage> {
  const end = Date.now() + timeoutMs;
  do {
    const message = await channel.get(queue, { noAck: false });
    if (message) return message;
    await delay(timeoutMs > 5_000 ? 250 : 50);
  } while (Date.now() < end);
  throw new Error('Expected synthetic delivery missing');
}

await test('S1.4-T3 PostgreSQL leases and real RabbitMQ delivery/failure windows', { timeout: 300_000 }, async t => {
  await ownedPostgres(); await ownedRabbit();
  const connectionConfig = loadInfrastructureConfig(process.env);
  const database = new DatabaseService(connectionConfig), db = database.client;
  const runId = randomUUID(), topology = taskTopology(`s12.t3.${runId.replaceAll('-', '')}`);
  const names = [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead, `${topology.namespace}.reject`];
  const owners: string[] = [];
  const connection = await connect(connectionConfig.rabbitmqUrl, { timeout: 5_000 });
  connection.on('error', () => {});
  const channel = await connection.createChannel(); channel.on('error', () => {});
  const initialQueues = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin([
    'list_queues', '-p', 'resume-studio-s12-test', 'name', '--formatter', 'json',
  ]));
  assert.ok(names.every(name => !initialQueues.some(queue => queue.name === name)));
  let reserved = false;
  t.after(async () => {
    try {
      await ownedRabbit(); await ownedPostgres();
      if (reserved) {
        // Only this run's exact namespace, checked absent before any declaration.
        const cleanup = await connection.createChannel(); cleanup.on('error', () => {});
        for (const name of names) await cleanup.deleteQueue(name);
        await cleanup.deleteExchange(topology.exchange); await cleanup.deleteExchange(topology.deadExchange);
        await rabbitAdmin(['clear_policy', '-p', 'resume-studio-s12-test', topology.policy]);
        await cleanup.close();
      }
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where: { ownerId } });
          await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.analysisTask.deleteMany({ where: { ownerId } });
          await tx.jobIndexTask.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
          await tx.diagnosticRecord.deleteMany({ where: { runId: ownerId } });
        });
        assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 0);
        assert.equal(await db.owner.count({ where: { id: ownerId } }), 0);
      }
      const queues = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin([
        'list_queues', '-p', 'resume-studio-s12-test', 'name', '--formatter', 'json',
      ]));
      assert.ok(queues.every(queue => !names.includes(queue.name)));
      t.diagnostic('T3 exact-run queues, policy, owner/tasks/outbox/receipt/effect removed; no shared queues purged');
    } finally {
      await channel.close().catch(() => {}); await connection.close().catch(() => {});
      await database.onModuleDestroy(); assert.equal(database.pool.totalCount, 0);
    }
  });
  reserved = true;
  await installTaskPolicy(topology);
  await declareTaskTopology(channel, topology);

  async function context(options: Parameters<typeof outboxConfigSchema.parse>[0] = {}) {
    const ownerId = randomUUID(); await db.owner.create({ data: { id: ownerId } }); owners.push(ownerId);
    const settings = outboxConfigSchema.parse(options);
    const identity = { getOwnerId: () => Promise.resolve(ownerId) };
    const tasks = new TaskCreationService(identity, new TaskRepository(database));
    const store = new OutboxStore(database, settings);
    const transport = new ConfirmedTaskPublisher(connectionConfig.rabbitmqUrl, topology, settings.publishTimeoutMs);
    return { ownerId, tasks, store, identity, settings, transport,
      publisher: new OutboxPublisher(store, transport, identity, settings) };
  }
  async function event(ownerId: string, taskId: string) {
    return db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: taskId } });
  }
  async function consume(queue: string) {
    const message = await receive(channel, queue); channel.ack(message); await channel.checkQueue(queue); return message;
  }
  async function drainOwnedQueue(queue: string) {
    // This namespace was absent before this run; no shared/application queue is drained.
    for (let index = 0; index < 20; index++) {
      const message = await channel.get(queue, { noAck: false });
      if (!message) return;
      channel.ack(message);
    }
    throw new Error('Unexpected synthetic queue contents');
  }

  await t.test('repeatable durable quorum topology and effective DLX policy; both task routes publish', async () => {
    await installTaskPolicy(topology); await declareTaskTopology(channel, topology);
    const queues = z.array(z.object({ name: z.string(), type: z.string(), policy: z.string(), durable: z.boolean() }))
      .parse(await rabbitAdmin(['list_queues', '-p', 'resume-studio-s12-test', 'name', 'type', 'policy', 'durable', '--formatter', 'json']));
    for (const name of names.slice(0, 4)) {
      const queue = queues.find(item => item.name === name);
      assert.equal(queue?.type, 'quorum'); assert.equal(queue?.durable, true);
      assert.equal(queue?.policy, [topology.analysis, topology.jobIndex].includes(name) ? topology.policy : '');
    }
    const c = await context();
    const a = await c.tasks.createAnalysis(randomUUID(), analysisInput()), j = await c.tasks.createJobIndex(randomUUID(), jobIndexInput());
    assert.deepEqual(await c.publisher.runBatch(), ['published', 'published', 'idle']);
    for (const [taskId, queue] of [[a.taskId, topology.analysis], [j.taskId, topology.jobIndex]]) {
      const stored = await event(c.ownerId, taskId!); assert.ok(stored.publishedAt);
      assert.equal(stored.publishAttempts, 1); assert.equal(stored.leaseOwner, null);
      const message = await consume(queue!);
      const payload = taskDispatchSchema.parse(JSON.parse(message.content.toString()) as unknown);
      assert.equal(payload.taskId, taskId); assert.equal(message.properties.messageId, stored.eventId);
      assert.equal(message.properties.deliveryMode, 2);
    }
  });

  await t.test('two publishers cannot claim the same event; row locks are skipped and stale lease writes fail', async () => {
    const c = await context();
    const tasks = await Promise.all(Array.from({ length: 4 }, () => c.tasks.createAnalysis(randomUUID(), analysisInput())));
    const second = new OutboxPublisher(c.store, c.transport, c.identity, c.settings);
    const results = await Promise.all([c.publisher.runOnce(), second.runOnce()]);
    assert.deepEqual(results, ['published', 'published']);
    await Promise.all([c.publisher.runOnce(), second.runOnce()]);
    const received = new Set<string>();
    for (let index = 0; index < 4; index++) received.add((await consume(topology.analysis)).properties.messageId);
    assert.equal(received.size, 4);
    for (const task of tasks) assert.equal((await event(c.ownerId, task.taskId)).publishAttempts, 1);

    const locked = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    const skippedTo = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    const session = await database.pool.connect();
    try {
      await session.query('BEGIN');
      await session.query('SELECT event_id FROM outbox_event WHERE owner_id = $1::uuid AND aggregate_id = $2::uuid FOR UPDATE', [c.ownerId, locked.taskId]);
      const claim = await c.store.claim(c.ownerId); assert.equal(claim?.aggregateId, skippedTo.taskId);
    } finally { await session.query('ROLLBACK'); session.release(); }
    const first = await c.store.claim(c.ownerId); assert.ok(first?.leaseOwner);
    await db.outboxEvent.update({ where: { eventId: first.eventId, ownerId: c.ownerId }, data: { leaseUntil: new Date(0) } });
    const next = await c.store.claim(c.ownerId); assert.ok(next?.leaseOwner);
    assert.equal(next.eventId, first.eventId); assert.notEqual(next.leaseOwner, first.leaseOwner);
    assert.equal(await c.store.markPublished(first), false);
    assert.equal(await c.store.markFailed(first, 'NACK', 500, false), false);
    assert.equal((await event(c.ownerId, locked.taskId)).publishedAt, null);
    assert.equal(await c.store.claim(randomUUID()), null);
  });

  await t.test('mandatory return then broker ACK leaves event unpublished with bounded backoff', async () => {
    await channel.unbindQueue(topology.analysis, topology.exchange, 'analysis.requested.v1');
    const c = await context({ maxAttempts: 2 });
    const task = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    try {
      const started = Date.now(); assert.equal(await c.publisher.runOnce(), 'failed');
      let row = await event(c.ownerId, task.taskId);
      assert.equal(row.publishedAt, null); assert.equal(row.lastErrorCode, 'UNROUTABLE'); assert.equal(row.failedAt, null);
      assert.ok(row.availableAt.getTime() >= started + 500);
      assert.equal(await c.publisher.runOnce(), 'idle');
      await db.outboxEvent.update({ where: { eventId: row.eventId, ownerId: c.ownerId }, data: { availableAt: new Date(0) } });
      assert.equal(await c.publisher.runOnce(), 'failed'); row = await event(c.ownerId, task.taskId);
      assert.ok(row.failedAt); assert.equal(row.publishAttempts, 2); assert.equal(row.publishedAt, null);
      assert.equal(await c.publisher.runOnce(), 'idle');
    } finally { await channel.bindQueue(topology.analysis, topology.exchange, 'analysis.requested.v1'); }
  });

  await t.test('real broker NACK from reject-publish overflow never marks success', async () => {
    const rejectQueue = names[4]!;
    await channel.assertQueue(rejectQueue, { durable: true, arguments: {
      'x-queue-type': 'quorum', 'x-max-length': 1, 'x-overflow': 'reject-publish',
    } });
    await channel.bindQueue(rejectQueue, topology.exchange, 'analysis.requested.v1');
    const c = await context();
    try {
      await c.tasks.createAnalysis(randomUUID(), analysisInput());
      assert.equal(await c.publisher.runOnce(), 'published');
      // Quorum length limits allow a bounded overshoot while rejection propagates to publishers.
      let nackObserved = false;
      for (let index = 0; index < 5 && !nackObserved; index++) {
        await delay(100);
        const task = await c.tasks.createAnalysis(randomUUID(), analysisInput());
        const outcome = await c.publisher.runOnce();
        const row = await event(c.ownerId, task.taskId);
        if (outcome === 'failed') {
          assert.equal(row.publishedAt, null); assert.equal(row.lastErrorCode, 'NACK'); nackObserved = true;
        } else assert.equal(outcome, 'published');
      }
      assert.equal(nackObserved, true, 'Must receive an actual broker NACK, not merely hit the configured limit');
    } finally {
      await channel.unbindQueue(rejectQueue, topology.exchange, 'analysis.requested.v1');
      await drainOwnedQueue(rejectQueue); await drainOwnedQueue(topology.analysis);
    }
  });

  for (const fault of ['timeout', 'disconnect'] as const) {
    await t.test(`real TCP ${fault} after AMQP publish leaves event unpublished and later reconnect succeeds`, async () => {
      const c = await context(), proxy = await amqpFaultProxy(fault);
      const task = await c.tasks.createAnalysis(randomUUID(), analysisInput());
      const url = new URL(connectionConfig.rabbitmqUrl); url.port = String(proxy.port);
      const transport = new ConfirmedTaskPublisher(url.toString(), topology, 1_000);
      try {
        assert.equal(await new OutboxPublisher(c.store, transport, c.identity, c.settings).runOnce(), 'failed');
        assert.equal(proxy.sawPublish(), true);
        const row = await event(c.ownerId, task.taskId);
        assert.equal(row.publishedAt, null);
        assert.equal(row.lastErrorCode, fault === 'timeout' ? 'CONFIRM_TIMEOUT' : 'CONNECTION_CLOSED');
        if (fault === 'timeout') await consume(topology.analysis);
        await db.outboxEvent.update({ where: { eventId: row.eventId, ownerId: c.ownerId }, data: { availableAt: new Date(0) } });
        assert.equal(await c.publisher.runOnce(), 'published'); await consume(topology.analysis);
      } finally { await proxy.close(); }
    });
  }

  await t.test('confirm then SIGKILL before mark replays same messageId; synthetic receipt absorbs duplicate', async () => {
    const c = await context();
    const task = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    const child = fork(new URL('./outbox-crash.fixture.js', import.meta.url), [], { silent: true,
      env: { ...process.env, S14_OWNER_ID: c.ownerId, S14_NAMESPACE: topology.namespace } });
    child.stdout?.resume(); child.stderr?.resume();
    const exit = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        exit.then(() => { throw new Error('Publisher exited before confirm'); }),
        delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Publisher IPC timeout'); }),
      ]);
      assert.deepEqual(ready[0], { type: 'confirmed-before-mark' });
      const row = await event(c.ownerId, task.taskId); assert.equal(row.publishedAt, null); assert.ok(row.leaseUntil);
      child.kill('SIGKILL'); await exit;
      assert.equal(await c.publisher.runOnce(), 'idle'); // still leased until original deadline
      await delay(Math.max(0, row.leaseUntil.getTime() - Date.now()) + 30);
      assert.equal(await c.publisher.runOnce(), 'published');
      for (let index = 0; index < 2; index++) {
        const message = await receive(channel, topology.analysis);
        const payload = taskDispatchSchema.parse(JSON.parse(message.content.toString()) as unknown);
        assert.equal(message.properties.messageId, row.eventId); assert.equal(payload.taskId, task.taskId);
        // T3 test-only consumer: one atomic receipt + synthetic effect. T4 provides production handling.
        await db.$transaction(async tx => {
          const receipt = await tx.consumerReceipt.findFirst({ where: {
            ownerId: c.ownerId, consumerName: 's14-t3-synthetic', messageId: payload.messageId,
          } });
          if (receipt) return;
          await tx.diagnosticRecord.create({ data: { id: randomUUID(), runId: c.ownerId, key: `t3.${payload.messageId}`, value: 'effect' } });
          await tx.consumerReceipt.create({ data: { id: randomUUID(), ownerId: c.ownerId,
            consumerName: 's14-t3-synthetic', messageId: payload.messageId, taskType: 'ANALYSIS', taskId: payload.taskId,
            analysisTaskId: payload.taskId, generation: payload.dispatchGeneration, status: 'DONE', processedAt: new Date() } });
        });
        channel.ack(message); await channel.checkQueue(topology.analysis);
      }
      assert.equal(await db.diagnosticRecord.count({ where: { runId: c.ownerId } }), 1);
      assert.equal(await db.consumerReceipt.count({ where: { ownerId: c.ownerId } }), 1);
      assert.equal((await event(c.ownerId, task.taskId)).publishAttempts, 2);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
  });

  await t.test('persisted age/attempt budgets and invalid payload stop automatic sends without losing events', async () => {
    const c = await context({ maxAttempts: 1, maxAgeMs: 15_000 });
    const task = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    const claim = await c.store.claim(c.ownerId); assert.ok(claim);
    await db.outboxEvent.update({ where: { eventId: claim.eventId, ownerId: c.ownerId }, data: { leaseUntil: new Date(0) } });
    assert.equal(await c.publisher.runOnce(), 'exhausted');
    const exhausted = await event(c.ownerId, task.taskId);
    assert.equal(exhausted.publishAttempts, 1); assert.ok(exhausted.failedAt); assert.equal(exhausted.publishedAt, null);
    const aged = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    const agedRow = await event(c.ownerId, aged.taskId);
    await db.outboxEvent.update({ where: { eventId: agedRow.eventId, ownerId: c.ownerId }, data: { createdAt: new Date(0) } });
    assert.equal(await c.publisher.runOnce(), 'exhausted');
    assert.equal((await event(c.ownerId, aged.taskId)).publishAttempts, 0);
    const invalid = await c.tasks.createAnalysis(randomUUID(), analysisInput());
    const invalidRow = await event(c.ownerId, invalid.taskId);
    await db.outboxEvent.update({ where: { eventId: invalidRow.eventId, ownerId: c.ownerId }, data: { payload: { schemaVersion: 99 } } });
    assert.equal(await c.publisher.runOnce(), 'invalid');
    assert.equal((await event(c.ownerId, invalid.taskId)).lastErrorCode, 'INVALID_EVENT');
    assert.equal((await channel.checkQueue(topology.analysis)).messageCount, 0);
  });

  await t.test('quorum at-least-once DLX retains a rejected message until missing dead binding is restored', async () => {
    const c = await context();
    await c.tasks.createJobIndex(randomUUID(), jobIndexInput());
    await channel.unbindQueue(topology.jobIndexDead, topology.deadExchange, 'job.index.requested.v1');
    try {
      assert.equal(await c.publisher.runOnce(), 'published');
      const message = await receive(channel, topology.jobIndex); channel.reject(message, false);
      await channel.checkQueue(topology.jobIndex);
      await delay(300);
      assert.equal((await channel.checkQueue(topology.jobIndexDead)).messageCount, 0);
      await channel.bindQueue(topology.jobIndexDead, topology.deadExchange, 'job.index.requested.v1');
      // RabbitMQ 4.4.0 dead_letter_worker_publisher_confirm_timeout is 180000ms.
      // Observe one complete internal retry cycle; client publishing remains bounded at 5s.
      const dead = await receive(channel, topology.jobIndexDead, 190_000);
      channel.ack(dead); await channel.checkQueue(topology.jobIndexDead);
      assert.equal(dead.properties.messageId, message.properties.messageId);
      const headers = z.object({ 'x-death': z.array(z.object({ queue: z.string(), reason: z.string() })).min(1) }).parse(dead.properties.headers);
      assert.equal(headers['x-death'][0]?.queue, topology.jobIndex);
      assert.equal(headers['x-death'][0]?.reason, 'rejected');
      assert.equal(taskPolicy(topology)['delivery-limit'], 5);
    } finally { await channel.bindQueue(topology.jobIndexDead, topology.deadExchange, 'job.index.requested.v1'); }
  });
});
