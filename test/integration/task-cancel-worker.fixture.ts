import 'reflect-metadata';
import { z } from 'zod';
import { once } from 'node:events';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';

const database = new DatabaseService(loadInfrastructureConfig(process.env));
try {
  const ownerId = z.uuid().parse(process.env.S18_OWNER_ID);
  const message = taskDispatchSchema.parse(JSON.parse(process.env.S18_MESSAGE ?? '') as unknown);
  const config = consumerConfigSchema.parse({ heartbeatMs: 100, leaseMs: 2000 });
  const handler = new TaskDeliveryHandler(new TaskExecutionStore(database, config), { getOwnerId: async () => ownerId }, {
    execute: async (claim, signal) => {
      process.send?.({ event: 'started' });
      if (!signal.aborted) await once(signal, 'abort');
      process.send?.({ event: 'aborted' });
      // Do not equate receiving abort with actual cleanup: parent releases the cleanup boundary.
      await new Promise<void>(resolve => {
        const release = (input: unknown) => { if (input === 'release') { process.off('message', release); resolve(); } };
        process.on('message', release);
      });
      return new SyntheticCompletionHandler().execute(claim, new AbortController().signal);
    },
  }, config, new PostgresExecutionLock(database.pool));
  const result = await handler.handle(message, new AbortController().signal);
  process.send?.({ event: result });
} catch { process.send?.({ event: 'failed' }); process.exitCode = 1; }
finally { await database.onModuleDestroy(); if (process.connected) process.disconnect(); }
