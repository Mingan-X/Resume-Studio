import 'reflect-metadata';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import {safeFailure} from '../support/safe-failure.js';
import {captureSocketDiagnostics} from '../support/socket-diagnostics.js';

let database:DatabaseService|undefined;const sockets=captureSocketDiagnostics();
try {
  const ownerId = z.uuid().parse(process.env.S16_OWNER_ID);
  const message = taskDispatchSchema.parse(JSON.parse(process.env.S16_MESSAGE ?? '') as unknown);
  const config = consumerConfigSchema.parse({}), db = new DatabaseService(loadInfrastructureConfig(process.env));
  database=db;
  const handler = new TaskDeliveryHandler(new TaskExecutionStore(db, config), { getOwnerId: () => Promise.resolve(ownerId) },
    { execute: () => { process.send?.({ type: 'executing-with-lock' }); return new Promise(() => {}); } },
    config, new PostgresExecutionLock(db.pool));
  await handler.handle(message, new AbortController().signal);
} catch(error) { process.send?.({ type: 'failed',...safeFailure(error),sockets:sockets.snapshot() }); process.exitCode = 1; }
finally{await database?.onModuleDestroy();sockets.close();}
