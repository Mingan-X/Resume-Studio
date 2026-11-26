import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { INFRA_CONFIG } from '../../infrastructure/tokens.js';
import { TaskQueryRepository } from '../../infrastructure/tasks/task-query.repository.js';
import { TaskQueryService } from './task-query.service.js';
import { TaskController } from './task.controller.js';

@Module({})
export class TaskApiModule {
  static register(config: { databaseUrl: string }): DynamicModule {
    return { module: TaskApiModule, imports: [IdentityModule], controllers: [TaskController],
      providers: [{ provide: INFRA_CONFIG, useValue: config }, DatabaseService, TaskQueryRepository, TaskQueryService] };
  }
}
