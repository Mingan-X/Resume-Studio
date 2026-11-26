import { z } from 'zod';
import { taskFailureCodeSchema } from '../../contracts/tasks.js';

export type TaskFailureCode = z.infer<typeof taskFailureCodeSchema>;
const transient = new Set<TaskFailureCode>(['UPSTREAM_TIMEOUT', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'UPSTREAM_5XX']);

// Adapters map documented upstream errors explicitly; never persist raw exception text/URLs.
export class TaskFailure extends Error {
  readonly code: TaskFailureCode;
  constructor(code: TaskFailureCode) {
    super(taskFailureCodeSchema.parse(code)); this.code = code;
  }
}
export function classifyTaskFailure(error: unknown): TaskFailure {
  if (error instanceof TaskFailure) return error;
  if (error instanceof z.ZodError) return new TaskFailure('OUTPUT_INVALID');
  return new TaskFailure('EXECUTION_FAILED');
}
export const isRetryable = (code: TaskFailureCode) => transient.has(code);

export function executionRetryDelay(attempts: number, random = Math.random()): number {
  z.int().positive().parse(attempts);
  const cap = attempts === 1 ? 30_000 : 120_000;
  return Math.floor(cap * (0.8 + z.number().min(0).max(1).parse(random) * 0.2));
}
