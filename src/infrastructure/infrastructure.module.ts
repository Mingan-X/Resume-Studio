import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { InfrastructureConfig } from './config.js';
import { INFRA_CONFIG } from './tokens.js';
import { DatabaseService } from './database/database.service.js';
import { RabbitmqService } from './messaging/rabbitmq.service.js';
import { VectorService } from './vector/vector.service.js';

// Opt-in context for infrastructure diagnostics. Not yet a dependency of the API or idle Worker.
@Module({})
export class InfrastructureModule {
  static register(config: InfrastructureConfig): DynamicModule {
    return {
      module: InfrastructureModule,
      providers: [
        { provide: INFRA_CONFIG, useValue: config },
        DatabaseService, RabbitmqService, VectorService,
      ],
      exports: [DatabaseService, RabbitmqService, VectorService],
    };
  }
}
