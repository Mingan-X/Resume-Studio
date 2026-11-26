import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { TaskCreationService } from './task-creation.service.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { TaskRepository } from '../../infrastructure/tasks/task.repository.js';
import { INFRA_CONFIG } from '../../infrastructure/tokens.js';
import type { InfrastructureConfig } from '../../infrastructure/config.js';

// Opt-in synthetic task context. API/Worker wiring and HTTP routes belong to later tasks.
@Module({})
export class TasksModule {
  static register(config: Pick<InfrastructureConfig, 'databaseUrl'>): DynamicModule {
    return {
      module: TasksModule,
      imports: [IdentityModule],
      providers: [
        { provide: INFRA_CONFIG, useValue: { databaseUrl: config.databaseUrl } },
        DatabaseService, TaskRepository, TaskCreationService,
      ],
      exports: [TaskCreationService],
    };
  }
}
