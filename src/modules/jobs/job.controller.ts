import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { jobPathSchema, jobVersionPathSchema, jobListQuerySchema } from '../../contracts/job-api.js';
import { createJobDraftSchema, editJobDraftSchema } from '../../contracts/job-drafts.js';
import { jobConfirmationSchema } from '../../contracts/job-publication.js';
import { taskQuerySchema } from '../../contracts/task-api.js';
import { idempotencyKeySchema } from '../../contracts/tasks.js';
import { ZodValidationPipe, RequestValidationError } from '../../infrastructure/http/zod-validation.pipe.js';
import { JobApiService } from './job-api.service.js';
function json(type: unknown) { if (typeof type !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(type)) throw new RequestValidationError(); }
@Controller('api/v1/jobs')
export class JobController {
  constructor(private readonly jobs: JobApiService) {}
  @Post() @HttpCode(201)
  create(@Body(new ZodValidationPipe(createJobDraftSchema)) body: z.infer<typeof createJobDraftSchema>,
    @Headers('content-type') type: unknown, @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) { json(type); return this.jobs.create(body); }
  @Get()
  list(@Query(new ZodValidationPipe(jobListQuerySchema)) query: z.infer<typeof jobListQuerySchema>) { return this.jobs.list(query.limit, query.cursor); }
  @Get(':jobId')
  get(@Param(new ZodValidationPipe(jobPathSchema)) path: z.infer<typeof jobPathSchema>, @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) { return this.jobs.get(path.jobId); }
  @Get(':jobId/versions/:versionId')
  version(@Param(new ZodValidationPipe(jobVersionPathSchema)) path: z.infer<typeof jobVersionPathSchema>, @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) { return this.jobs.version(path.jobId, path.versionId); }
  @Patch(':jobId/versions/:versionId')
  edit(@Param(new ZodValidationPipe(jobVersionPathSchema)) path: z.infer<typeof jobVersionPathSchema>,
    @Body(new ZodValidationPipe(editJobDraftSchema)) body: z.infer<typeof editJobDraftSchema>, @Headers('content-type') type: unknown,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) { json(type); return this.jobs.edit(path.jobId, path.versionId, body); }
  @Post(':jobId/versions/:versionId/confirm') @HttpCode(200)
  confirm(@Param(new ZodValidationPipe(jobVersionPathSchema)) path: z.infer<typeof jobVersionPathSchema>,
    @Body(new ZodValidationPipe(jobConfirmationSchema)) body: z.infer<typeof jobConfirmationSchema>, @Headers('content-type') type: unknown,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) { json(type); return this.jobs.confirm(path.jobId, path.versionId, body); }
  @Post(':jobId/versions/:versionId/publish') @HttpCode(202)
  publish(@Param(new ZodValidationPipe(jobVersionPathSchema)) path: z.infer<typeof jobVersionPathSchema>,
    @Body(new ZodValidationPipe(taskQuerySchema)) _body: unknown, @Headers('content-type') type: unknown,
    @Headers('idempotency-key') rawKey: unknown, @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown) {
    json(type); const key = idempotencyKeySchema.safeParse(rawKey); if (!key.success) throw new RequestValidationError();
    return this.jobs.publish(path.jobId, path.versionId, key.data);
  }
  @Post(':jobId/versions/:versionId/suggestions') @HttpCode(200)
  async suggest(@Param(new ZodValidationPipe(jobVersionPathSchema)) path: z.infer<typeof jobVersionPathSchema>,
    @Body(new ZodValidationPipe(taskQuerySchema)) _body: unknown, @Headers('content-type') type: unknown,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: unknown, @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: ServerResponse) {
    json(type); const abort = new AbortController(), stop = () => { if (!response.writableFinished) abort.abort(); };
    request.once('aborted', stop); response.once('close', stop);
    try { return await this.jobs.suggest(path.jobId, path.versionId, abort.signal); }
    finally { request.off('aborted', stop); response.off('close', stop); }
  }
}
