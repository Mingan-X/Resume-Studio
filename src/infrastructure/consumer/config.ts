import { z } from 'zod';

export const consumerConfigSchema = z.object({
  leaseMs: z.int().min(2_000).max(120_000).default(60_000),
  heartbeatMs: z.int().min(100).max(30_000).default(10_000),
  executionTimeoutMs: z.int().min(1_000).max(600_000).default(600_000),
}).strict().refine(value => value.leaseMs >= value.heartbeatMs * 3);
export type ConsumerConfig = z.infer<typeof consumerConfigSchema>;
