import {Controller,Get,Param,Query} from '@nestjs/common';
import type {z} from 'zod';
import {reportPathSchema,pageQuerySchema} from '../../contracts/reports.js';
import {taskQuerySchema} from '../../contracts/task-api.js';
import {ZodValidationPipe} from '../../infrastructure/http/zod-validation.pipe.js';
import {ReportService} from './report.service.js';
@Controller('api/v1/reports')
export class ReportController {
 constructor(private readonly reports:ReportService){}
 @Get() list(@Query(new ZodValidationPipe(pageQuerySchema)) query:z.infer<typeof pageQuerySchema>){return this.reports.list(query);}
 @Get(':reportId') get(@Param(new ZodValidationPipe(reportPathSchema)) path:z.infer<typeof reportPathSchema>,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown){return this.reports.get(path.reportId);}
 @Get(':reportId/revisions') revisions(@Param(new ZodValidationPipe(reportPathSchema))path:z.infer<typeof reportPathSchema>,@Query(new ZodValidationPipe(pageQuerySchema))query:z.infer<typeof pageQuerySchema>){return this.reports.list(query,path.reportId);}
}
