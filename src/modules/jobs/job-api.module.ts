import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { IdentityModule, IDENTITY } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { INFRA_CONFIG } from '../../infrastructure/tokens.js';
import { JobRepository } from '../../infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../infrastructure/jobs/publication.repository.js';
import { JobDraftService } from './job-draft.service.js';
import { JobPublicationService, JOB_INDEX_TARGET } from './job-publication.service.js';
import { JobExtractionService } from './job-extraction.service.js';
import { JobApiService } from './job-api.service.js';
import { JobController } from './job.controller.js';
import { jobIndexTargetSchema } from '../../contracts/job-publication.js';
import { OpenAiModel, openAiModelConfigSchema } from '../../infrastructure/models/openai-model.js';
import { ModelExecutor, modelExecutionPolicySchema } from '../models/model-executor.js';
import { ObservabilityModule, ObservabilityService } from '../../infrastructure/observability/observability.module.js';
import { loadObservabilityConfig } from '../../infrastructure/observability/config.js';
import { ConfigValidationError } from '../config/app-config.js';
import {LifecycleRepository} from '../../infrastructure/tasks/lifecycle.repository.js';

async function localJson(path: string): Promise<unknown> {
  const info = await stat(path); if (!info.isFile() || info.size > 65536) throw new Error();
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
@Module({})
export class JobApiModule {
  static async register(config: { databaseUrl: string; modelConfigFile?: string | undefined; indexTargetFile?: string | undefined }, sessionIdentity=false): Promise<DynamicModule> {
    let model: ModelExecutor | undefined, target: z.infer<typeof jobIndexTargetSchema> | undefined;
    if (config.modelConfigFile) try {
      const value = z.object({ connection: openAiModelConfigSchema, execution: modelExecutionPolicySchema }).strict().parse(await localJson(config.modelConfigFile));
      model = new ModelExecutor(new OpenAiModel(value.connection), value.execution);
    } catch { throw new ConfigValidationError(['JOB_MODEL_CONFIG_FILE']); }
    if (config.indexTargetFile) try { target = jobIndexTargetSchema.parse(await localJson(config.indexTargetFile)); }
    catch { throw new ConfigValidationError(['JOB_INDEX_TARGET_FILE']); }
    return { module: JobApiModule, imports: [sessionIdentity?IdentityModule.session():IdentityModule, ObservabilityModule.register(loadObservabilityConfig(process.env))],
      controllers: [JobController], providers: [
        { provide: INFRA_CONFIG, useValue: { databaseUrl: config.databaseUrl } }, DatabaseService, JobRepository, JobPublicationRepository,LifecycleRepository,
        JobDraftService, JobPublicationService, JobApiService, { provide: JOB_INDEX_TARGET, useValue: target ?? null },
        { provide: JobExtractionService, inject: [IDENTITY, JobRepository, ObservabilityService,LifecycleRepository],
          useFactory: (identity: IdentityPort, jobs: JobRepository, observation: ObservabilityService,lifecycle:LifecycleRepository) => new JobExtractionService(identity, jobs, model, observation,(owner,id)=>lifecycle.trace(owner,id)) },
      ] };
  }
}
