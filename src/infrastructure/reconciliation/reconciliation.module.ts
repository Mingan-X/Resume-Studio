import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY, IdentityModule } from '../../modules/identity/identity.module.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import { DatabaseService } from '../database/database.service.js';
import type { InfrastructureConfig } from '../config.js';
import { INFRA_CONFIG } from '../tokens.js';
import { TaskExecutionStore } from '../consumer/task-execution.store.js';
import { consumerConfigSchema } from '../consumer/config.js';
import { OutboxStore } from '../outbox/outbox.store.js';
import { OutboxPublisher } from '../outbox/outbox.publisher.js';
import { outboxConfigSchema } from '../outbox/config.js';
import { ConfirmedTaskPublisher } from '../messaging/confirmed-publisher.js';
import { taskTopology } from '../messaging/task-topology.js';
import { reconciliationConfigSchema } from './config.js';
import { ReconciliationStore } from './reconciliation.store.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({})
export class ReconciliationModule {
  static register(config: Pick<InfrastructureConfig, 'databaseUrl' | 'rabbitmqUrl'>): DynamicModule {
    return { module: ReconciliationModule, imports: [IdentityModule], providers: [
      { provide: INFRA_CONFIG, useValue: { databaseUrl: config.databaseUrl } }, DatabaseService,
      { provide: ReconciliationService, inject: [DatabaseService, IDENTITY], useFactory: (db: DatabaseService, identity: IdentityPort) => {
        const delivery = outboxConfigSchema.parse({});
        return new ReconciliationService(new ReconciliationStore(db), new TaskExecutionStore(db, consumerConfigSchema.parse({})),
          new OutboxPublisher(new OutboxStore(db, delivery), new ConfirmedTaskPublisher(config.rabbitmqUrl, taskTopology(), delivery.publishTimeoutMs), identity, delivery),
          identity, reconciliationConfigSchema.parse({}));
      } },
    ], exports: [ReconciliationService] };
  }
}
