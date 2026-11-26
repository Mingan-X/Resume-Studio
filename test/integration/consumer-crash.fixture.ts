import 'reflect-metadata';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { taskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';

try {
  const ownerId = z.uuid().parse(process.env.S14_OWNER_ID);
  const connection = loadInfrastructureConfig(process.env), config = consumerConfigSchema.parse({});
  const database = new DatabaseService(connection);
  const handler = new TaskDeliveryHandler(new TaskExecutionStore(database, config),
    { getOwnerId: () => Promise.resolve(ownerId) }, new SyntheticCompletionHandler(), config, new PostgresExecutionLock(database.pool));
  const consumer = new TaskConsumer(connection.rabbitmqUrl, taskTopology(process.env.S14_NAMESPACE), {
    handle: async (message, signal) => {
      const disposition = await handler.handle(message, signal);
      if (disposition !== 'ack') throw new Error('Expected committed completion');
      process.send?.({ type: 'committed-before-ack' });
      return new Promise(() => {}); // parent kills this process at the real commit/ACK boundary
    },
  });
  await consumer.run('analysis', { maxMessages: 1, windowMs: 30_000 });
  await database.onModuleDestroy();
} catch { process.send?.({ type: 'failed' }); process.exitCode = 1; }
