import { z } from 'zod';
import { taskFailureCodeSchema } from './tasks.js';

export const taskPathSchema = z.object({ taskId: z.uuid() }).strict();
export const taskQuerySchema = z.object({}).strict();
export const cancelTaskRequestSchema = z.object({}).strict();
export const cancelTaskResponseSchema = z.object({ taskId: z.uuid(), cancelRequested: z.literal(true) }).strict();
export const taskErrorSchema = z.object({ code: taskFailureCodeSchema, message: z.string(), retryable: z.boolean() }).strict();
const progressSchema = z.object({ completed: z.int().nonnegative(), total: z.int().nonnegative().nullable() }).strict()
  .refine(value => value.total === null || value.completed <= value.total);
const common = {
  taskId: z.uuid(), stage: z.string().min(1).max(64), progress: progressSchema,
  attempt: z.int().nonnegative(), nextRetryAt: z.iso.datetime().nullable(),
  error: taskErrorSchema.nullable(), cancelRequested: z.boolean(),
};
export const taskResponseSchema = z.discriminatedUnion('taskType', [
  z.object({ ...common, taskType: z.literal('ANALYSIS'),
    status: z.enum(['QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','PARTIAL','FAILED','CANCELLED']), reportId: z.uuid().nullable() }).strict(),
  z.object({ ...common, taskType: z.literal('JOB_INDEX'),
    status: z.enum(['QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED']), reportId: z.null() }).strict(),
]);
export type TaskResponse = z.infer<typeof taskResponseSchema>;
export type CancelTaskResponse = z.infer<typeof cancelTaskResponseSchema>;
