import 'reflect-metadata';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { taskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { TaskFailure } from '../../src/infrastructure/consumer/failure.js';
import { QuarantineStore } from '../../src/infrastructure/consumer/quarantine.store.js';

try {
  const ownerId = z.uuid().parse(process.env.S15_OWNER_ID), mode = z.enum(['retry','dead','quarantine']).parse(process.env.S15_MODE);
  const connection = loadInfrastructureConfig(process.env), config = consumerConfigSchema.parse({});
  const database = new DatabaseService(connection), identity = { getOwnerId: () => Promise.resolve(ownerId) };
  const stopBeforeAck = (): Promise<void> => { process.send?.({ type: 'handoff-before-ack', mode }); return new Promise(() => {}); };
  const handler = new TaskDeliveryHandler(new TaskExecutionStore(database, config), identity,
    { execute: () => Promise.reject(new TaskFailure(mode === 'retry' ? 'UPSTREAM_TIMEOUT' : 'INPUT_INVALID')) }, config);
  const quarantine = new QuarantineStore(database, identity);
  const consumer = new TaskConsumer(connection.rabbitmqUrl, taskTopology(process.env.S15_NAMESPACE), {
    handle: async (message, signal) => { const result = await handler.handle(message, signal); await stopBeforeAck(); return result; },
  }, { persist: async (delivery, type, code) => { await quarantine.persist(delivery, type, code); await stopBeforeAck(); } });
  await consumer.run('analysis', { maxMessages: 1, windowMs: 30_000 });
  await database.onModuleDestroy();
} catch { process.send?.({ type: 'failed' }); process.exitCode = 1; }
