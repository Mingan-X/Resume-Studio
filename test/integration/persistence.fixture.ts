import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { Test } from '@nestjs/testing';
import { InfrastructureModule } from '../../src/infrastructure/infrastructure.module.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { RabbitmqService, diagnosticMessageSchema } from '../../src/infrastructure/messaging/rabbitmq.service.js';
import { VectorService } from '../../src/infrastructure/vector/vector.service.js';

const manifestSchema = z.object({ runId: z.uuid(), id: z.uuid(), messageId: z.uuid() }).strict();
const command = z.enum(['prepare', 'verify', 'cleanup']).parse(process.argv[2]);
const config = loadInfrastructureConfig(process.env);
const file = 'data/s12-persistence.json';

async function run(): Promise<void> {
  await mkdir('data', { recursive: true });
  const manifest = command === 'prepare'
    ? { runId: randomUUID(), id: randomUUID(), messageId: randomUUID() }
    : manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
  // Reserve the run before writes. If preparation fails, cleanup can still target its own resources.
  if (command === 'prepare') await writeFile(file, JSON.stringify(manifest), { flag: 'wx' });
  const module = await Test.createTestingModule({ imports: [InfrastructureModule.register(config)] }).compile();
  await module.init();
  const database = module.get(DatabaseService).client;
  const rabbit = module.get(RabbitmqService);
  const vector = module.get(VectorService).client;
  const key = `s12.persistence.${manifest.runId}`;
  const collection = `s12_persistence_${manifest.runId.replaceAll('-', '_')}`;
  try {
    await rabbit.open();
    const channel = await rabbit.createChannel();
    if (command === 'prepare') {
      await database.diagnosticRecord.create({ data: {
        id: manifest.id, runId: manifest.runId, key, value: 'survives-container-restart',
      } });
      await channel.assertExchange(key, 'direct', { durable: true });
      await channel.assertQueue(key, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
      await channel.bindQueue(key, key, 'diagnostic');
      await rabbit.publish(key, 'diagnostic', {
        schemaVersion: 1, messageId: manifest.messageId, runId: manifest.runId, kind: 'diagnostic',
      });
      await vector.createCollection(collection, { vectors: { size: 3, distance: 'Cosine' } });
      await vector.upsert(collection, { wait: true, points: [{ id: manifest.id, vector: [1, 0, 0] }] });
    } else if (command === 'verify') {
      const record = await database.diagnosticRecord.findUniqueOrThrow({ where: { id: manifest.id } });
      assert.equal(record.runId, manifest.runId);
      assert.equal(record.value, 'survives-container-restart');
      const count = await channel.checkQueue(key);
      assert.equal(count.messageCount, 1);
      const message = await channel.get(key, { noAck: false });
      assert.ok(message);
      assert.equal(diagnosticMessageSchema.parse(JSON.parse(message.content.toString()) as unknown).messageId, manifest.messageId);
      // Return it so verification is repeatable; never acknowledge persistence evidence prematurely.
      channel.nack(message, false, true);
      await channel.checkQueue(key);
      const result = await vector.query(collection, { query: [1, 0, 0], limit: 1 });
      assert.equal(result.points[0]?.id, manifest.id);
    } else {
      await database.diagnosticRecord.deleteMany({ where: { id: manifest.id, runId: manifest.runId } });
      // Exact run IDs only. RabbitMQ deletion of an absent queue/exchange is idempotent.
      await channel.deleteQueue(key);
      await channel.deleteExchange(key);
      if ((await vector.collectionExists(collection)).exists) await vector.deleteCollection(collection);
      await unlink(file);
    }
    await channel.close();
    console.log(`Infrastructure persistence ${command}: passed.`);
  } finally { await module.close(); }
}

try { await run(); }
catch {
  console.error(`Infrastructure persistence ${command} failed; raw service errors omitted to protect credentials.`);
  process.exitCode = 1;
}
