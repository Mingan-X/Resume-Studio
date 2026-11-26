import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY, IdentityModule } from '../../modules/identity/identity.module.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import type { InfrastructureConfig } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { INFRA_CONFIG } from '../tokens.js';
import { taskTopology } from '../messaging/task-topology.js';
import { consumerConfigSchema } from './config.js';
import { TaskExecutionStore } from './task-execution.store.js';
import { SyntheticCompletionHandler, TaskDeliveryHandler } from './task-delivery.handler.js';
import { TaskConsumer } from './task.consumer.js';
import { QuarantineStore } from './quarantine.store.js';

@Module({})
export class ConsumerModule {
  static register(config: Pick<InfrastructureConfig, 'databaseUrl' | 'rabbitmqUrl'>): DynamicModule {
    const execution = consumerConfigSchema.parse({});
    return { module: ConsumerModule, imports: [IdentityModule], providers: [
      { provide: INFRA_CONFIG, useValue: { databaseUrl: config.databaseUrl } }, DatabaseService,
      { provide: TaskExecutionStore, inject: [DatabaseService], useFactory: (db: DatabaseService) => new TaskExecutionStore(db, execution) },
      { provide: TaskDeliveryHandler, inject: [TaskExecutionStore, IDENTITY], useFactory: (store: TaskExecutionStore, identity: IdentityPort) =>
        new TaskDeliveryHandler(store, identity, new SyntheticCompletionHandler(), execution) },
      { provide: QuarantineStore, inject: [DatabaseService, IDENTITY], useFactory: (db: DatabaseService, identity: IdentityPort) => new QuarantineStore(db, identity) },
      { provide: TaskConsumer, inject: [TaskDeliveryHandler, QuarantineStore], useFactory: (handler: TaskDeliveryHandler, quarantine: QuarantineStore) =>
        new TaskConsumer(config.rabbitmqUrl, taskTopology(), handler, quarantine) },
    ], exports: [TaskConsumer] };
  }
}
