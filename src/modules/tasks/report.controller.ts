import {Body,Controller,Get,Headers,HttpCode,Param,Post,Query} from '@nestjs/common';
import type {z} from 'zod';
import {reportPathSchema,pageQuerySchema,recomputeRequestSchema} from '../../contracts/reports.js';
import {taskQuerySchema} from '../../contracts/task-api.js';
import {idempotencyKeySchema} from '../../contracts/tasks.js';
import {RequestValidationError,ZodValidationPipe} from '../../infrastructure/http/zod-validation.pipe.js';
import {ReportService} from './report.service.js';
@Controller('api/v1/reports')
export class ReportController {
 constructor(private readonly reports:ReportService){}
 @Get() list(@Query(new ZodValidationPipe(pageQuerySchema)) query:z.infer<typeof pageQuerySchema>){return this.reports.list(query);}
 @Get(':reportId') get(@Param(new ZodValidationPipe(reportPathSchema)) path:z.infer<typeof reportPathSchema>,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown){return this.reports.get(path.reportId);}
 @Get(':reportId/revisions') revisions(@Param(new ZodValidationPipe(reportPathSchema))path:z.infer<typeof reportPathSchema>,@Query(new ZodValidationPipe(pageQuerySchema))query:z.infer<typeof pageQuerySchema>){return this.reports.list(query,path.reportId);}
 @Post(':reportId/recompute') @HttpCode(201)
 recompute(@Param(new ZodValidationPipe(reportPathSchema))path:z.infer<typeof reportPathSchema>,@Body(new ZodValidationPipe(recomputeRequestSchema))body:z.infer<typeof recomputeRequestSchema>,
 @Headers('idempotency-key')key:unknown,@Headers('content-type')type:unknown,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown){
  const parsed=idempotencyKeySchema.safeParse(key);if(!parsed.success||typeof type!=='string'||!/^application\/json(?:\s*;.*)?$/i.test(type))throw new RequestValidationError();
  return this.reports.recompute(path.reportId,parsed.data,body);
 }
}
