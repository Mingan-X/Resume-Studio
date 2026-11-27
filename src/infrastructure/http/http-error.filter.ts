import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ServerResponse } from 'node:http';
import { errorResponseSchema } from '../../contracts/http.js';
import { AppLogger } from '../logging/app-logger.js';
import { RequestValidationError } from './zod-validation.pipe.js';
import { IdempotencyConflictError, TaskNotFoundError, TaskInvalidStateError, AnalysisInputStateError } from '../../modules/tasks/task-errors.js';
import { ParseFailure } from '../../modules/parsing/contracts.js';
import { StorageError } from '../../modules/storage/storage.port.js';
import { ModelFailure } from '../../modules/models/model.port.js';
import { z } from 'zod';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: AppLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ServerResponse>();
    const fileReason = exception instanceof ParseFailure ? exception.reason
      : exception instanceof StorageError && exception.code === 'FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : undefined;
    const jobCode = exception instanceof Error && ['JOB_NOT_FOUND', 'RUBRIC_NOT_FOUND', 'JOB_INVALID_STATE', 'DRAFT_REQUIRED', 'JOB_NOT_CONFIRMED', 'JD_EDIT_INVALIDATES_REQUIREMENTS', 'JOB_INDEX_TARGET_UNAVAILABLE'].includes(exception.message) ? exception.message : undefined;
    const schemaError = exception instanceof z.ZodError;
    const evidenceError = exception instanceof Error && exception.message === 'INVALID_EVIDENCE';
    const analysisConfigMissing = exception instanceof Error && exception.message === 'ANALYSIS_CONFIG_UNAVAILABLE';
    const status = analysisConfigMissing ? 503 : exception instanceof ModelFailure ? exception.code === 'OUTPUT_INVALID' ? 422 : exception.code === 'BUDGET_EXHAUSTED' ? 422 : 503
      : schemaError || evidenceError ? 400 : jobCode === 'JOB_INDEX_TARGET_UNAVAILABLE' ? 503 : jobCode?.endsWith('NOT_FOUND') ? 404 : jobCode ? 409
      : fileReason ? fileReason === 'FILE_TOO_LARGE' ? 413 : 422
      : exception instanceof IdempotencyConflictError ? exception.statusCode
      : exception instanceof TaskNotFoundError ? 404 : exception instanceof TaskInvalidStateError ? 409
      : exception instanceof HttpException ? exception.getStatus() : 500;
    const code = analysisConfigMissing ? 'ANALYSIS_UNAVAILABLE' : exception instanceof ModelFailure ? exception.code === 'OUTPUT_INVALID' ? 'MODEL_OUTPUT_INVALID' : exception.code === 'BUDGET_EXHAUSTED' ? 'MODEL_BUDGET_EXHAUSTED' : 'MODEL_UNAVAILABLE'
      : schemaError || evidenceError ? 'VALIDATION_ERROR' : jobCode === 'JOB_INDEX_TARGET_UNAVAILABLE' ? 'INDEX_TARGET_UNAVAILABLE' : jobCode ? status === 404 ? 'NOT_FOUND' : 'INVALID_STATE'
      : fileReason ? status === 413 ? 'PAYLOAD_TOO_LARGE' : 'UNSUPPORTED_FILE'
      : exception instanceof IdempotencyConflictError ? exception.code
      : exception instanceof TaskInvalidStateError ? 'INVALID_STATE'
      : exception instanceof RequestValidationError ? 'VALIDATION_ERROR'
      : status === 400 ? 'BAD_REQUEST'
      : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 429 ? 'RATE_LIMITED' : status === 413 ? 'PAYLOAD_TOO_LARGE'
      : status === 404 ? 'NOT_FOUND'
      : status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
    const message = code === 'IDEMPOTENCY_CONFLICT' ? '该幂等键已用于不同的请求'
      : code === 'INVALID_STATE' ? exception instanceof AnalysisInputStateError ? '分析输入或配置版本状态不允许此操作' : jobCode ? '岗位状态或引用不允许此操作' : '任务已结束，无法取消'
      : code === 'VALIDATION_ERROR' ? '请求参数无效'
      : code === 'BAD_REQUEST' ? '请求格式无效'
      : code === 'NOT_FOUND' ? '资源不存在'
      : code === 'INTERNAL_ERROR' ? '服务暂时无法处理请求' : '请求无法处理';
    const payload = errorResponseSchema.parse({
      code, message, retryable: status === 429 || status === 502 || status === 503 || status === 504,
      requestId: response.getHeader('x-request-id'),
      ...(fileReason ? { reason: fileReason } : {}),
      ...(exception instanceof RequestValidationError && exception.fields ? { details: { fields: exception.fields } } : {}),
      ...(schemaError ? { details: { fields: exception.issues.slice(0, 20).map(issue => ({ path: issue.path.map(part => typeof part === 'number' ? String(part) : /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(part)) ? String(part) : 'field').join('.'), code: issue.code })) } } : {}),
    });
    this.logger.write('error', { event: 'http_error', code, statusCode: status, requestId: payload.requestId });
    this.adapterHost.httpAdapter.reply(response, payload, status);
  }
}
