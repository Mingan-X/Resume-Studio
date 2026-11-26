import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { taskPathSchema, taskQuerySchema, cancelTaskRequestSchema } from '../../contracts/task-api.js';
import { RequestValidationError, ZodValidationPipe } from '../../infrastructure/http/zod-validation.pipe.js';
import { TaskQueryService } from './task-query.service.js';

@Controller('api/v1/tasks')
export class TaskController {
  constructor(private readonly tasks: TaskQueryService) {}

  @Get(':taskId')
  get(@Param(new ZodValidationPipe(taskPathSchema)) path: z.infer<typeof taskPathSchema>,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: z.infer<typeof taskQuerySchema>) {
    return this.tasks.get(path.taskId);
  }

  @Post(':taskId/cancel')
  @HttpCode(202)
  cancel(@Param(new ZodValidationPipe(taskPathSchema)) path: z.infer<typeof taskPathSchema>,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: z.infer<typeof taskQuerySchema>,
    @Body(new ZodValidationPipe(cancelTaskRequestSchema)) _body: z.infer<typeof cancelTaskRequestSchema>,
    @Headers('content-type') contentType: unknown) {
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(contentType)) throw new RequestValidationError();
    return this.tasks.cancel(path.taskId);
  }
}
