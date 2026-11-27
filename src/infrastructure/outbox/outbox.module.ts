import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY, IdentityModule } from '../../modules/identity/identity.module.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import { DatabaseService } from '../database/database.service.js';
import type { InfrastructureConfig } from '../config.js';
import { INFRA_CONFIG } from '../tokens.js';
import { ConfirmedTaskPublisher } from '../messaging/confirmed-publisher.js';
import { taskTopology } from '../messaging/task-topology.js';
import { outboxConfigSchema } from './config.js';
import { OutboxStore } from './outbox.store.js';
import { OutboxPublisher } from './outbox.publisher.js';

@Module({})
export class OutboxModule {
  static register(connection: Pick<InfrastructureConfig, 'databaseUrl' | 'rabbitmqUrl'>, identity?:IdentityPort): DynamicModule {
    const config = outboxConfigSchema.parse({});
    return {
      module: OutboxModule, imports: [IdentityModule],
      providers: [
        ...(identity?[{provide:IDENTITY,useValue:identity}]:[]),
        { provide: INFRA_CONFIG, useValue: { databaseUrl: connection.databaseUrl } }, DatabaseService,
        { provide: OutboxStore, inject: [DatabaseService], useFactory: (database: DatabaseService) => new OutboxStore(database, config) },
        { provide: OutboxPublisher, inject: [OutboxStore, IDENTITY], useFactory: (store: OutboxStore, identity: IdentityPort) =>
          new OutboxPublisher(store, new ConfirmedTaskPublisher(connection.rabbitmqUrl, taskTopology(), config.publishTimeoutMs), identity, config) },
      ], exports: [OutboxPublisher],
    };
  }
}
