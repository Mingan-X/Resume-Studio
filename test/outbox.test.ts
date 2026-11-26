import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import type { Options, ConfirmChannel } from 'amqplib';
import { awaitConfirm, ConfirmedTaskPublisher } from '../src/infrastructure/messaging/confirmed-publisher.js';
import { PublishError } from '../src/infrastructure/messaging/rabbitmq.service.js';
import { taskTopology, taskPolicy } from '../src/infrastructure/messaging/task-topology.js';
import { outboxConfigSchema, retryDelay } from '../src/infrastructure/outbox/config.js';
import { dispatchFromClaim, OutboxPublisher } from '../src/infrastructure/outbox/outbox.publisher.js';
import { validateRabbitOwnership } from '../src/infrastructure/messaging/ownership.js';
import { taskDispatchSchema } from '../src/contracts/tasks.js';

const message = () => taskDispatchSchema.parse({ schemaVersion: 1, messageId: randomUUID(), taskType: 'analysis',
  taskId: randomUUID(), dispatchGeneration: 1, occurredAt: new Date().toISOString() });

class FakeChannel extends EventEmitter {
  sent: { options: Options.Publish; content: Buffer }[] = [];
  confirm: (error?: unknown) => void = () => {};
  publish: ConfirmChannel['publish'] = (_exchange, _route, content, options, callback) => {
    this.sent.push({ options: options ?? {}, content });
    this.confirm = error => callback?.(error, {});
    return false;
  };
}

await test('confirm waits despite publish(false), preserves messageId and uses fresh correlation for each send', async () => {
  const channel = new FakeChannel(), connection = new EventEmitter(), input = message();
  let resolved = false;
  const first = awaitConfirm(channel, connection, 'resume.tasks', 'analysis.requested.v1', input).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(channel.sent[0]?.options.mandatory, true);
  assert.equal(channel.sent[0]?.options.persistent, true);
  assert.equal(channel.sent[0]?.options.messageId, input.messageId);
  channel.confirm(); await first;
  const second = awaitConfirm(channel, connection, 'resume.tasks', 'analysis.requested.v1', input);
  assert.notEqual(channel.sent[0]?.options.correlationId, channel.sent[1]?.options.correlationId);
  channel.confirm(); await second;
  assert.equal(channel.listenerCount('return'), 0); assert.equal(connection.listenerCount('close'), 0);
});

await test('return before ACK, NACK and disconnected channels never complete as published', async () => {
  for (const code of ['UNROUTABLE', 'NACK', 'CONNECTION_CLOSED'] as const) {
    const channel = new FakeChannel(), connection = new EventEmitter();
    const pending = awaitConfirm(channel, connection, 'resume.tasks', 'analysis.requested.v1', message());
    if (code === 'UNROUTABLE') {
      channel.emit('return', { properties: { correlationId: channel.sent[0]?.options.correlationId } });
      channel.confirm();
    } else if (code === 'NACK') channel.confirm(new Error('synthetic nack'));
    else connection.emit('close');
    await assert.rejects(pending, error => error instanceof PublishError && error.code === code);
    channel.confirm();
    assert.equal(channel.listenerCount('return'), 0); assert.equal(connection.listenerCount('close'), 0);
  }
});

await test('AMQP handshake timeout and cancellation destroy this attempt socket', async () => {
  const server = createServer(socket => { socket.resume(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const publisher = new ConfirmedTaskPublisher(`amqp://127.0.0.1:${address.port}`, taskTopology(), 150);
    const accepted = once(server, 'connection');
    const published = publisher.publish(message());
    const [socket] = await accepted;
    const closed = once(socket, 'close');
    await assert.rejects(published, error => error instanceof PublishError && error.code === 'CONFIRM_TIMEOUT');
    await closed;
    const abort = new AbortController(); abort.abort();
    await assert.rejects(publisher.publish(message(), abort.signal), PublishError);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

await test('retry budgets, capped jitter, strict dispatch references and quorum policy', () => {
  const config = outboxConfigSchema.parse({});
  assert.equal(retryDelay(config, 1, 0), 500);
  assert.equal(retryDelay(config, 1, 1), 1_000);
  assert.equal(retryDelay(config, 20, 1), 30_000);
  assert.throws(() => outboxConfigSchema.parse({ maxAttempts: 0 }));
  assert.throws(() => outboxConfigSchema.parse({ leaseMs: 6_000 }));
  const payload = message();
  const claim = { eventId: payload.messageId, ownerId: randomUUID(), aggregateType: 'AnalysisTask',
    aggregateId: payload.taskId, eventType: 'analysis.requested.v1', payloadVersion: 1, payload,
    publishAttempts: 1, leaseOwner: randomUUID(), createdAt: new Date(), failedAt: null };
  assert.deepEqual(dispatchFromClaim(claim), payload);
  for (const changed of [{ aggregateId: randomUUID() }, { eventId: randomUUID() }, { payloadVersion: 2 },
    { aggregateType: 'JobIndexTask' }, { eventType: 'other.v1' }, { payload: { ...payload, secret: 'synthetic' } }]) {
    assert.throws(() => dispatchFromClaim({ ...claim, ...changed }));
  }
  const policy = taskPolicy(taskTopology());
  assert.equal(policy['dead-letter-strategy'], 'at-least-once');
  assert.equal(policy.overflow, 'reject-publish'); assert.equal(policy['delivery-limit'], 5);
  assert.throws(() => taskTopology('foreign'));
});

await test('RabbitMQ ownership rejects mismatched project, volume and public ports', () => {
  const labels = { 'com.docker.compose.project': 'resume-studio', 'com.docker.compose.service': 'rabbitmq' };
  const container = { Config: { Labels: labels }, State: { Running: true },
    NetworkSettings: { Ports: { '5672/tcp': [{ HostIp: '127.0.0.1', HostPort: '55672' }],
      '15672/tcp': [{ HostIp: '127.0.0.1', HostPort: '55673' }] } },
    Mounts: [{ Type: 'volume', Name: 'resume-studio_rabbitmq_data', Destination: '/var/lib/rabbitmq' }] };
  const volume = { Name: 'resume-studio_rabbitmq_data', Labels: {
    'com.docker.compose.project': 'resume-studio', 'com.docker.compose.volume': 'rabbitmq_data' } };
  validateRabbitOwnership(container, volume);
  assert.throws(() => validateRabbitOwnership({ ...container, Config: { Labels: { ...labels, 'com.docker.compose.project': 'foreign' } } }, volume));
  assert.throws(() => validateRabbitOwnership(container, { ...volume, Name: 'foreign_data' }));
  assert.throws(() => validateRabbitOwnership({ ...container, NetworkSettings: { Ports: {} } }, volume));
});

await test('expiry after claiming prevents network work and a cancelled batch reports stopped', async () => {
  const payload = message(), ownerId = randomUUID();
  const claim = { eventId: payload.messageId, ownerId, aggregateType: 'AnalysisTask', aggregateId: payload.taskId,
    eventType: 'analysis.requested.v1', payloadVersion: 1, payload, publishAttempts: 1,
    leaseOwner: randomUUID(), createdAt: new Date(0), failedAt: null };
  let claims = 0, sends = 0, failed = 0;
  const publisher = new OutboxPublisher({
    claim: () => { claims++; return Promise.resolve(claim); },
    markPublished: () => { assert.fail('Expired work must not be marked published'); },
    markFailed: (_claim, code, delayMs, permanent) => {
      assert.equal(code, 'CONFIRM_TIMEOUT'); assert.equal(delayMs, 0); assert.equal(permanent, true);
      failed++; return Promise.resolve(true);
    },
  }, { publish: () => { sends++; return Promise.resolve(); } },
  { getOwnerId: () => Promise.resolve(ownerId) }, outboxConfigSchema.parse({}));
  assert.equal(await publisher.runOnce(), 'exhausted');
  assert.equal(claims, 1); assert.equal(sends, 0); assert.equal(failed, 1);
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await publisher.runBatch(abort.signal), ['stopped']);
  assert.equal(claims, 1);
});
