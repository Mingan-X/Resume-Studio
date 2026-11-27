import { Body, Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createAnalysisRequestSchema } from '../../contracts/analyses.js';
import { idempotencyKeySchema } from '../../contracts/tasks.js';
import { taskQuerySchema } from '../../contracts/task-api.js';
import { ZodValidationPipe, RequestValidationError } from '../../infrastructure/http/zod-validation.pipe.js';
import { AnalysisCreationService } from './analysis-creation.service.js';

@Controller('api/v1/analyses')
export class AnalysisController {
  constructor(private readonly analyses: AnalysisCreationService) {}
  @Post() @HttpCode(202)
  create(@Body(new ZodValidationPipe(createAnalysisRequestSchema)) request: z.infer<typeof createAnalysisRequestSchema>,
    @Headers('idempotency-key') rawKey: unknown, @Headers('content-type') type: unknown,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) {
    if (typeof type !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(type)) throw new RequestValidationError();
    const key = idempotencyKeySchema.safeParse(rawKey); if (!key.success) throw new RequestValidationError();
    return this.analyses.create(key.data, request);
  }
}
