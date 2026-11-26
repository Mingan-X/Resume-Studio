import { z } from 'zod';

export const outboxConfigSchema = z.object({
  publishTimeoutMs: z.int().min(100).max(5_000).default(5_000),
  leaseMs: z.int().min(6_000).max(60_000).default(15_000),
  maxAttempts: z.int().min(1).max(20).default(8),
  maxAgeMs: z.int().min(10_000).max(86_400_000).default(3_600_000),
  retryBaseMs: z.int().min(100).max(30_000).default(1_000),
  retryMaxMs: z.int().min(100).max(300_000).default(30_000),
  batchLimit: z.int().min(1).max(100).default(10),
  batchTimeoutMs: z.int().min(10_000).max(120_000).default(60_000),
}).strict().refine(value => value.leaseMs >= value.publishTimeoutMs + 6_000
  && value.retryMaxMs >= value.retryBaseMs && value.maxAgeMs >= value.leaseMs
  && value.batchTimeoutMs > value.publishTimeoutMs);
export type OutboxConfig = z.infer<typeof outboxConfigSchema>;

// Equal jitter in [50%,100%] of the capped exponential interval; never a zero-delay hot loop.
export function retryDelay(config: OutboxConfig, attempt: number, random = Math.random()): number {
  const cap = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(Math.max(0, attempt - 1), 20));
  return Math.floor(cap * (0.5 + z.number().min(0).max(1).parse(random) / 2));
}
