import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ServerResponse } from 'node:http';
import { errorResponseSchema } from '../../contracts/http.js';
import { AppLogger } from '../logging/app-logger.js';
import { RequestValidationError } from './zod-validation.pipe.js';
import { IdempotencyConflictError, TaskNotFoundError, TaskInvalidStateError } from '../../modules/tasks/task-errors.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: AppLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ServerResponse>();
    const status = exception instanceof IdempotencyConflictError ? exception.statusCode
      : exception instanceof TaskNotFoundError ? 404 : exception instanceof TaskInvalidStateError ? 409
      : exception instanceof HttpException ? exception.getStatus() : 500;
    const code = exception instanceof IdempotencyConflictError ? exception.code
      : exception instanceof TaskInvalidStateError ? 'INVALID_STATE'
      : exception instanceof RequestValidationError ? 'VALIDATION_ERROR'
      : status === 400 ? 'BAD_REQUEST'
      : status === 404 ? 'NOT_FOUND'
      : status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
    const message = code === 'IDEMPOTENCY_CONFLICT' ? '该幂等键已用于不同的请求'
      : code === 'INVALID_STATE' ? '任务已结束，无法取消'
      : code === 'VALIDATION_ERROR' ? '请求参数无效'
      : code === 'BAD_REQUEST' ? '请求格式无效'
      : code === 'NOT_FOUND' ? '资源不存在'
      : code === 'INTERNAL_ERROR' ? '服务暂时无法处理请求' : '请求无法处理';
    const payload = errorResponseSchema.parse({
      code, message, retryable: status === 429 || status === 502 || status === 503 || status === 504,
      requestId: response.getHeader('x-request-id'),
    });
    this.logger.write('error', { event: 'http_error', code, statusCode: status, requestId: payload.requestId });
    this.adapterHost.httpAdapter.reply(response, payload, status);
  }
}
