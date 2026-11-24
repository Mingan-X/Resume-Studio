import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ConfigService } from '../../modules/config/config.module.js';
import { requestContext } from './request-context.js';

// Allowlisted metadata only: no URL, body, headers, config values or raw exception.
const eventSchema = z.object({
  event: z.enum(['application_started', 'application_stopped', 'http_request_completed', 'http_error']),
  requestId: z.uuid().optional(),
  statusCode: z.int().min(100).max(599).optional(),
  durationMs: z.number().nonnegative().optional(),
  code: z.enum(['VALIDATION_ERROR', 'BAD_REQUEST', 'NOT_FOUND', 'HTTP_ERROR', 'INTERNAL_ERROR']).optional(),
}).strict();

type LogEvent = z.infer<typeof eventSchema>;

@Injectable()
export class AppLogger {
  constructor(private readonly config: ConfigService) {}

  write(level: 'info' | 'error', event: LogEvent): void {
    const requestId = requestContext.getStore()?.requestId;
    const metadata = eventSchema.parse({ ...(requestId ? { requestId } : {}), ...event });
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(), level, role: this.config.values.role, ...metadata,
    })}\n`);
  }
}
