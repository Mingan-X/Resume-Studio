import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { INFRA_CONFIG } from '../../infrastructure/tokens.js';
import { TaskQueryRepository } from '../../infrastructure/tasks/task-query.repository.js';
import { TaskQueryService } from './task-query.service.js';
import { TaskController } from './task.controller.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisRepository } from '../../infrastructure/tasks/analysis.repository.js';
import { ANALYSIS_CONFIGURATION, AnalysisCreationService } from './analysis-creation.service.js';
import {ReportController} from './report.controller.js';
import {ReportService} from './report.service.js';
import {ReportRepository} from '../../infrastructure/tasks/report.repository.js';
import {AnalysisQueryRepository} from '../../infrastructure/tasks/analysis-query.repository.js';
import {TaskEventRepository} from '../../infrastructure/tasks/task-event.repository.js';
import {TaskEventsController,EventStreamLimits} from './task-events.controller.js';

@Module({})
export class TaskApiModule {
  static register(config: { databaseUrl: string }, analysisConfiguration: unknown = null, sessionIdentity=false): DynamicModule {
    return { module: TaskApiModule, imports: [sessionIdentity?IdentityModule.session():IdentityModule], controllers: [TaskController, AnalysisController,ReportController,TaskEventsController],
      providers: [{ provide: INFRA_CONFIG, useValue: config }, DatabaseService, TaskQueryRepository, TaskQueryService,
        AnalysisRepository, AnalysisCreationService,ReportRepository,ReportService,AnalysisQueryRepository,TaskEventRepository,EventStreamLimits, { provide: ANALYSIS_CONFIGURATION, useValue: analysisConfiguration }] };
  }
}
