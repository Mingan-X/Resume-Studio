import { Body, Controller, Headers, HttpCode, Post, Query,Get,Param,Inject } from '@nestjs/common';
import type { z } from 'zod';
import { createAnalysisRequestSchema } from '../../contracts/analyses.js';
import { idempotencyKeySchema } from '../../contracts/tasks.js';
import { taskQuerySchema } from '../../contracts/task-api.js';
import { ZodValidationPipe, RequestValidationError } from '../../infrastructure/http/zod-validation.pipe.js';
import { AnalysisCreationService,ANALYSIS_CONFIGURATION } from './analysis-creation.service.js';
import {AnalysisQueryRepository} from '../../infrastructure/tasks/analysis-query.repository.js';
import {analysisPathSchema,analysisDetailSchema,analysisOptionsQuerySchema,pageQuerySchema,analysisConfigurationViewSchema} from '../../contracts/analysis-api.js';
import {IDENTITY,ownerIdSchema} from '../identity/identity.module.js';
import type {IdentityPort} from '../identity/identity.module.js';
import {TaskQueryService} from './task-query.service.js';

@Controller('api/v1/analyses')
export class AnalysisController {
  constructor(private readonly analyses: AnalysisCreationService,private readonly queries:AnalysisQueryRepository,
    @Inject(IDENTITY)private readonly identity:IdentityPort,private readonly tasks:TaskQueryService,@Inject(ANALYSIS_CONFIGURATION)private readonly configuration:unknown) {}
  @Get() async list(@Query(new ZodValidationPipe(pageQuerySchema))query:unknown){return this.queries.list(ownerIdSchema.parse(await this.identity.getOwnerId()),query);}
  @Get('options') async options(@Query(new ZodValidationPipe(analysisOptionsQuerySchema))query:unknown){const options=await this.queries.options(ownerIdSchema.parse(await this.identity.getOwnerId()),query);
    return {...options,configuration:this.configuration?analysisConfigurationViewSchema.strip().parse(this.configuration):null};}
  @Get(':taskId') async get(@Param(new ZodValidationPipe(analysisPathSchema))path:z.infer<typeof analysisPathSchema>,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown){
    return analysisDetailSchema.parse({analysis:await this.queries.get(ownerIdSchema.parse(await this.identity.getOwnerId()),path.taskId),task:await this.tasks.get(path.taskId)});
  }
  @Post() @HttpCode(202)
  create(@Body(new ZodValidationPipe(createAnalysisRequestSchema)) request: z.infer<typeof createAnalysisRequestSchema>,
    @Headers('idempotency-key') rawKey: unknown, @Headers('content-type') type: unknown,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) {
    if (typeof type !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(type)) throw new RequestValidationError();
    const key = idempotencyKeySchema.safeParse(rawKey); if (!key.success) throw new RequestValidationError();
    return this.analyses.create(key.data, request);
  }
}
