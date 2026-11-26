import 'reflect-metadata';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { OutboxStore } from '../../src/infrastructure/outbox/outbox.store.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox.publisher.js';
import { outboxConfigSchema } from '../../src/infrastructure/outbox/config.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { taskTopology } from '../../src/infrastructure/messaging/task-topology.js';

try {
  const ownerId = z.uuid().parse(process.env.S14_OWNER_ID);
  const connection = loadInfrastructureConfig(process.env);
  const database = new DatabaseService(connection);
  class CrashAfterConfirm extends OutboxStore {
    override markPublished(): Promise<boolean> {
      process.send?.({ type: 'confirmed-before-mark' });
      return new Promise(() => {}); // parent kills the real process after this exact failure window
    }
  }
  const config = outboxConfigSchema.parse({});
  const publisher = new OutboxPublisher(new CrashAfterConfirm(database, config),
    new ConfirmedTaskPublisher(connection.rabbitmqUrl, taskTopology(process.env.S14_NAMESPACE), config.publishTimeoutMs),
    { getOwnerId: () => Promise.resolve(ownerId) }, config);
  await publisher.runOnce();
  await database.onModuleDestroy();
} catch {
  process.send?.({ type: 'failed' });
  process.exitCode = 1;
}
