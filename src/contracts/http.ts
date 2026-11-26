import { z } from 'zod';
import { uploadFailureReasonSchema } from './resumes.js';

export const healthQuerySchema = z.object({}).strict();
export type HealthQuery = z.infer<typeof healthQuerySchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  environment: z.enum(['development', 'test', 'production']),
}).strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  code: z.enum(['VALIDATION_ERROR', 'BAD_REQUEST', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'HTTP_ERROR', 'INTERNAL_ERROR', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_FILE']),
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.uuid(),
  reason: uploadFailureReasonSchema.optional(),
}).strict();
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
