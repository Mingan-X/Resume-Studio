import { z } from 'zod';

export const reconciliationConfigSchema = z.object({
  intervalMs: z.int().min(100).max(300_000).default(10_000),
  staleMs: z.int().min(1_000).max(3_600_000).default(120_000),
  pageSize: z.int().min(1).max(100).default(10),
  cycleTimeoutMs: z.int().min(1_000).max(120_000).default(60_000),
  maxRecoveries: z.int().min(1).max(10).default(3),
  maxConsecutiveErrors: z.int().min(1).max(5).default(3),
}).strict();
export type ReconciliationConfig = z.infer<typeof reconciliationConfigSchema>;
