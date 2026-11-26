import { Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { resumeListQuerySchema, resumeVersionPathSchema } from '../../contracts/resumes.js';
import { taskQuerySchema } from '../../contracts/task-api.js';
import { idempotencyKeySchema } from '../../contracts/tasks.js';
import { RequestValidationError, ZodValidationPipe } from '../../infrastructure/http/zod-validation.pipe.js';
import { receiveResume } from '../../infrastructure/http/resume-multipart.js';
import { ResumeService } from './resume.service.js';

@Controller('api/v1/resumes')
export class ResumeController {
  constructor(private readonly resumes: ResumeService) {}
  @Post()
  @HttpCode(201)
  async upload(@Headers('idempotency-key') rawKey: unknown, @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: ServerResponse,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: z.infer<typeof taskQuerySchema>) {
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) throw new RequestValidationError();
    const abort = new AbortController(), disconnected = () => { if (!response.writableFinished) abort.abort(); };
    request.once('aborted', disconnected); response.once('close', disconnected);
    try {
      const { file, filename, mime } = await receiveResume(request, this.resumes.storage, abort.signal);
      return await this.resumes.upload(key.data, file, filename, mime, abort.signal);
    } finally { request.removeListener('aborted', disconnected); response.removeListener('close', disconnected); }
  }
  @Get()
  list(@Query(new ZodValidationPipe(resumeListQuerySchema)) query: z.infer<typeof resumeListQuerySchema>) {
    return this.resumes.list(query.limit, query.cursor);
  }
  @Get(':resumeId/versions/:versionId')
  detail(@Param(new ZodValidationPipe(resumeVersionPathSchema)) path: z.infer<typeof resumeVersionPathSchema>,
    @Query(new ZodValidationPipe(taskQuerySchema)) _query: z.infer<typeof taskQuerySchema>) {
    return this.resumes.get(path.resumeId, path.versionId);
  }
}
