import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connect } from 'amqplib';
import type { ChannelModel } from 'amqplib';
import { z } from 'zod';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { verifyProjectNetwork } from '../support/project-network.js';

const execute = promisify(execFile);
// Explicit opt-in fixture, never restarted by the ordinary test:integration glob.
await test('S3.3 broker restart preserves confirmed durable messages and redelivers unACKed delivery', { timeout: 180_000 }, async () => {
  const postgres = await ownedPostgres(), broker = await ownedRabbit();
  await verifyProjectNetwork(postgres); const networkId = await verifyProjectNetwork(broker);
  const config = loadInfrastructureConfig(process.env), database = new DatabaseService(config);
  const runId = randomUUID(), queue = `s12.s33.${runId.replaceAll('-', '')}`, messageId = randomUUID(), exchange = `${queue}.exchange`;
  let before: ChannelModel | undefined, after: ChannelModel | undefined, created = false, cleaned = false;
  let stage = 'preflight', primary: unknown, cleanupFailure: unknown;
  await mkdir('data/s33-faults', { recursive: true });
  const save = () => writeFile(`data/s33-faults/${runId}.json`, JSON.stringify({ runId, project: 'resume-studio',
    service: 'rabbitmq', containerId: broker, networkId, queue, exchange, messageId, stage, created, cleaned }, null, 2));
  await save();
  try {
    const active = { status: { in: ['QUEUED', 'RUNNING', 'RETRY_WAIT'] as ('QUEUED' | 'RUNNING' | 'RETRY_WAIT')[] } };
    assert.equal(await database.client.analysisTask.count({ where: active }), 0, 'Active analyses prohibit broker restart');
    assert.equal(await database.client.jobIndexTask.count({ where: active }), 0, 'Active indexes prohibit broker restart');
    assert.equal(await database.client.outboxEvent.count({ where: { publishedAt: null, failedAt: null } }), 0);
    const queues = z.array(z.object({ name: z.string(), messages: z.number(), consumers: z.number() })).parse(
      await rabbitAdmin(['list_queues', '-p', 'resume-studio-s12-test', 'name', 'messages', 'consumers', '--formatter', 'json']));
    assert.ok(queues.every(item => item.messages === 0 && item.consumers === 0 && item.name !== queue));
    before = await connect(config.rabbitmqUrl, { timeout: 5000 }); before.on('error', () => {});
    const channel = await before.createConfirmChannel(); channel.on('error', () => {});
    await channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } }); created = true; await save();
    await channel.assertExchange(exchange, 'direct', { durable: true }); await channel.bindQueue(queue, exchange, 'event');
    stage = 'publish'; await save();
    channel.publish(exchange, 'event', Buffer.from('synthetic-restart-payload'), { persistent: true, messageId }); await channel.waitForConfirms();
    const delivery = await channel.get(queue, { noAck: false }); assert.ok(delivery); assert.equal(delivery.properties.messageId, messageId);
    assert.equal(await ownedRabbit(), broker); assert.equal(await verifyProjectNetwork(broker), networkId);
    stage = 'restart'; await save();
    try { await execute('docker', ['restart', '--time', '10', broker], { timeout: 60_000 }); }
    catch { throw new Error('PROJECT_BROKER_RESTART_FAILED'); }
    const deadline = Date.now() + 90_000; let healthy = false;
    while (Date.now() < deadline) {
      const health = await execute('docker', ['inspect', '--format', '{{.State.Health.Status}}', broker], { timeout: 5000 });
      if (health.stdout.trim() === 'healthy') { healthy = true; break; } await delay(500);
    }
    assert.equal(healthy, true, 'Restarted broker must become healthy within the drill deadline');
    assert.equal(await ownedRabbit(), broker); assert.equal(await verifyProjectNetwork(broker), networkId);
    stage = 'redelivery'; await save();
    after = await connect(config.rabbitmqUrl, { timeout: 5000 }); after.on('error', () => {});
    const restored = await after.createChannel(); restored.on('error', () => {});
    const redelivery = await restored.get(queue, { noAck: false }); assert.ok(redelivery);
    assert.equal(redelivery.properties.messageId, messageId); assert.equal(redelivery.fields.redelivered, true);
    assert.equal(redelivery.content.toString(), 'synthetic-restart-payload');
    restored.ack(redelivery); assert.equal((await restored.checkQueue(queue)).messageCount, 0);
    stage = 'verified'; await save();
  } catch (error) { primary = error; } finally {
    try {
      if (created) {
        assert.equal(await ownedRabbit(), broker); assert.equal(await verifyProjectNetwork(broker), networkId);
        const cleanup = await connect(config.rabbitmqUrl, { timeout: 5000 }); cleanup.on('error', () => {});
        try { const channel = await cleanup.createChannel(); channel.on('error', () => {});
          assert.equal((await channel.checkQueue(queue)).consumerCount, 0);
          // RabbitMQ quorum queues do not implement queue.delete(ifUnused).
          // The queue/exchange belong to this manifest only; verify consumers explicitly.
          await channel.deleteQueue(queue); await channel.deleteExchange(exchange); cleaned = true; await save(); }
        finally { await cleanup.close().catch(() => {}); }
      }
    } catch (error) { cleanupFailure = error; }
    finally { await before?.close().catch(() => {}); await after?.close().catch(() => {}); await database.onModuleDestroy(); }
  }
  if (primary || cleanupFailure) throw new AggregateError([primary, cleanupFailure].filter(Boolean), 'BROKER_DRILL_OR_CLEANUP_FAILED');
});
