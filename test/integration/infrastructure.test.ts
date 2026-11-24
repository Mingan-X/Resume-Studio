import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { Channel, ConsumeMessage } from 'amqplib';
import { InfrastructureModule } from '../../src/infrastructure/infrastructure.module.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { RabbitmqService, PublishError, diagnosticMessageSchema } from '../../src/infrastructure/messaging/rabbitmq.service.js';
import { VectorService } from '../../src/infrastructure/vector/vector.service.js';

// Required, never skip-on-missing: an integration run must actually contact the services.
const config = loadInfrastructureConfig(process.env);

async function receiveOne(channel: Channel, queue: string): Promise<ConsumeMessage> {
  let tag: string | undefined;
  try {
    return await new Promise<ConsumeMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for diagnostic delivery.')), 5_000);
      void channel.consume(queue, message => {
        clearTimeout(timer);
        if (message) resolve(message); else reject(new Error('Consumer cancelled.'));
      }, { noAck: false }).then(result => { tag = result.consumerTag; }, error => {
        clearTimeout(timer); reject(error);
      });
    });
  } finally {
    if (tag) await channel.cancel(tag);
  }
}

async function pendingCount(channel: Channel, queue: string, expected: number): Promise<void> {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if ((await channel.checkQueue(queue)).messageCount === expected) return;
    await delay(50);
  }
  assert.equal((await channel.checkQueue(queue)).messageCount, expected);
}

await test('Real PostgreSQL, RabbitMQ and Qdrant diagnostics', { timeout: 45_000 }, async t => {
  const module = await Test.createTestingModule({ imports: [InfrastructureModule.register(config)] }).compile();
  await module.init();
  const database = module.get(DatabaseService);
  const rabbit = module.get(RabbitmqService);
  const vector = module.get(VectorService).client;
  const runId = randomUUID();
  t.after(async () => {
    await module.close();
    assert.equal(database.pool.totalCount, 0, 'Nest shutdown must drain the external pg pool.');
  });

  await t.test('Prisma CRUD, unique constraints, rollback and bounded pool', async () => {
    const db = database.client;
    try {
      await database.check();
      assert.equal(database.connectionHealthy, true);
      const first = await db.diagnosticRecord.create({ data: { id: randomUUID(), runId, key: `s12.${runId}`, value: 'before' } });
      assert.equal((await db.diagnosticRecord.findUniqueOrThrow({ where: { id: first.id } })).value, 'before');
      await db.diagnosticRecord.update({ where: { id: first.id }, data: { value: 'after' } });
      assert.equal((await db.diagnosticRecord.findUniqueOrThrow({ where: { id: first.id } })).value, 'after');
      await assert.rejects(db.diagnosticRecord.create({ data: {
        id: randomUUID(), runId, key: first.key, value: 'duplicate',
      } }), { code: 'P2002' });
      const rollback = `s12.rollback.${runId}`;
      await assert.rejects(db.$transaction(async tx => {
        await tx.diagnosticRecord.create({ data: { id: randomUUID(), runId, key: rollback, value: 'not committed' } });
        throw new Error('intentional rollback');
      }), /intentional rollback/);
      assert.equal(await db.diagnosticRecord.findUnique({ where: { key: rollback } }), null);
      await Promise.all(Array.from({ length: 8 }, () => database.check()));
      assert.ok(database.pool.totalCount <= 3);
    } finally {
      await db.diagnosticRecord.deleteMany({ where: { runId } });
    }
    assert.equal(await db.diagnosticRecord.count({ where: { runId } }), 0);
  });

  await t.test('confirms, mandatory return, manual ACK, redelivery and duplicate delivery', async () => {
    await rabbit.open();
    const admin = await rabbit.createChannel();
    const exchange = `s12.exchange.${runId}`, queue = `s12.queue.${runId}`;
    let createdExchange = false, createdQueue = false;
    try {
      await admin.assertExchange(exchange, 'direct', { durable: true }); createdExchange = true;
      await admin.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } }); createdQueue = true;
      await admin.bindQueue(queue, exchange, 'diagnostic');
      const message = { schemaVersion: 1, messageId: randomUUID(), runId, kind: 'diagnostic' } as const;
      await rabbit.publish(exchange, 'diagnostic', message);
      await pendingCount(admin, queue, 1);
      // A mandatory unroutable message can receive a broker ACK too. It must still fail.
      await assert.rejects(rabbit.publish(exchange, 'no-binding', { ...message, messageId: randomUUID() }),
        (error: unknown) => error instanceof PublishError && error.code === 'UNROUTABLE');
      await pendingCount(admin, queue, 1);

      const firstConsumer = await rabbit.createChannel();
      await firstConsumer.prefetch(1);
      const first = await receiveOne(firstConsumer, queue);
      assert.deepEqual(diagnosticMessageSchema.parse(JSON.parse(first.content.toString()) as unknown), message);
      assert.equal(first.fields.redelivered, false);
      // Closing the consumer channel without ACK forces the real broker to requeue.
      await firstConsumer.close();
      await pendingCount(admin, queue, 1);
      const secondConsumer = await rabbit.createChannel();
      await secondConsumer.prefetch(1);
      const redelivered = await receiveOne(secondConsumer, queue);
      assert.equal(redelivered.fields.redelivered, true);
      assert.equal(redelivered.properties.messageId, message.messageId);
      secondConsumer.ack(redelivered);
      await secondConsumer.checkQueue(queue); // ordered RPC flushes the ACK on this channel
      await secondConsumer.close();
      await pendingCount(admin, queue, 0);

      // RabbitMQ does not deduplicate business messageIds; consumers must handle duplicate delivery.
      await rabbit.publish(exchange, 'diagnostic', message);
      await rabbit.publish(exchange, 'diagnostic', message);
      await pendingCount(admin, queue, 2);
      const consumer = await rabbit.createChannel();
      await consumer.prefetch(1);
      for (let i = 0; i < 2; i++) {
        const duplicate = await receiveOne(consumer, queue);
        assert.equal(duplicate.properties.messageId, message.messageId);
        consumer.ack(duplicate);
        await consumer.checkQueue(queue);
      }
      await consumer.close();
      await pendingCount(admin, queue, 0);
    } finally {
      if (createdQueue) await admin.deleteQueue(queue);
      if (createdExchange) await admin.deleteExchange(exchange);
      await admin.close();
    }
  });

  await t.test('Qdrant upsert/query/delete and wrong dimensions return a recognizable error', async () => {
    const collection = `s12_${runId.replaceAll('-', '_')}`;
    // Reserve this unique name before sending the create request. A timeout can still mean
    // the server committed creation, so cleanup cannot depend on the response succeeding.
    assert.equal((await vector.collectionExists(collection)).exists, false);
    try {
      await vector.createCollection(collection, { vectors: { size: 3, distance: 'Cosine' } });
      await vector.upsert(collection, { wait: true, points: [
        { id: 1, vector: [1, 0, 0], payload: { runId, skill: 'synthetic-a' } },
        { id: 2, vector: [0, 1, 0], payload: { runId, skill: 'synthetic-b' } },
      ] });
      const results = await vector.query(collection, { query: [1, 0, 0], limit: 1, with_payload: true });
      assert.equal(results.points[0]?.id, 1);
      assert.equal(results.points[0]?.payload?.runId, runId);
      await assert.rejects(vector.upsert(collection, { wait: true, points: [{ id: 3, vector: [1, 0] }] }),
        (error: unknown) => {
          assert.ok(typeof error === 'object' && error !== null && 'status' in error);
          assert.equal(error.status, 400);
          return true;
        });
      assert.equal((await vector.count(collection, { exact: true })).count, 2);
      await vector.delete(collection, { wait: true, points: [1, 2] });
      assert.equal((await vector.count(collection, { exact: true })).count, 0);
    } finally {
      if ((await vector.collectionExists(collection)).exists) await vector.deleteCollection(collection);
    }
  });
});
