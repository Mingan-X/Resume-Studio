import { z } from 'zod';
import { taskDispatchSchema, quarantineCodeSchema } from '../../contracts/tasks.js';
import type { TaskDispatch, TaskType, AnalysisInputSnapshot, JobIndexInputSnapshot } from '../../contracts/tasks.js';
import { jobIndexCompletionSchema } from '../../contracts/job-index.js';

export const syntheticCompletionSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('synthetic'),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), completedUnits: z.literal(1),
}).strict();
export type SyntheticCompletion = z.infer<typeof syntheticCompletionSchema>;
export const taskCompletionSchema = z.discriminatedUnion('kind', [syntheticCompletionSchema, jobIndexCompletionSchema]);
export type TaskCompletion = z.infer<typeof taskCompletionSchema>;
export const syntheticNodeOutputSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('synthetic'), node: z.enum(['first','second','index']),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), value: z.int(),
}).strict();
export type SyntheticNodeOutput = z.infer<typeof syntheticNodeOutputSchema>;
export type ExecutionClaim = {
  ownerId: string; consumerName: string; message: TaskDispatch;
  attemptId: string; fenceToken: bigint; startedAt: Date; deadline: Date;
  snapshot: AnalysisInputSnapshot | JobIndexInputSnapshot;
  graph?: { threadId: string; generation: number };
};
export type ClaimResult = { kind: 'acquired'; claim: ExecutionClaim } | { kind: 'ack' | 'deferred' };

export const consumerName = (type: TaskType) => type === 'analysis' ? 'analysis.worker.v1' : 'job-index.worker.v1';
export const taskRoute = (type: TaskType) => type === 'analysis' ? 'analysis.requested.v1' : 'job.index.requested.v1';

export class RejectedTaskDelivery extends Error {
  constructor(readonly code: z.infer<typeof quarantineCodeSchema>) { super(quarantineCodeSchema.parse(code)); }
}

export function decodeTaskDelivery(delivery: { content: Buffer; properties: { contentType?: unknown; messageId?: unknown };
  fields: { exchange: string; routingKey: string } }, taskType: TaskType, exchange: string): TaskDispatch {
  if (delivery.content.length > 8_192 || delivery.properties.contentType !== 'application/json'
    || delivery.fields.exchange !== exchange || delivery.fields.routingKey !== taskRoute(taskType)) {
    throw new RejectedTaskDelivery('MALFORMED_MESSAGE');
  }
  let message: TaskDispatch;
  try { message = taskDispatchSchema.parse(JSON.parse(delivery.content.toString('utf8')) as unknown); }
  catch { throw new RejectedTaskDelivery('MALFORMED_MESSAGE'); }
  if (message.taskType !== taskType || delivery.properties.messageId !== message.messageId) {
    throw new RejectedTaskDelivery('MALFORMED_MESSAGE');
  }
  return message;
}

export class ExecutionLeaseLostError extends Error {
  constructor() { super('TASK_EXECUTION_LEASE_LOST'); }
}

export class ExecutionUnsettledError extends Error {
  constructor() { super('TASK_EXECUTION_DID_NOT_SETTLE'); }
}
