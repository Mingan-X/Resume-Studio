import { z } from 'zod';

export const embeddingUsageSchema = z.object({ inputTokens: z.int().nonnegative(),
  costMicros: z.int().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
export const embeddingResponseSchema = z.object({ vectors: z.array(z.array(z.number()).min(1)).min(1),
  usage: embeddingUsageSchema.nullable(),
}).strict();
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;
export interface EmbeddingPort {
  readonly embeddingVersion: string;
  readonly dimensions: number;
  readonly provenance: 'synthetic' | 'bailian';
  embed(texts: string[], signal: AbortSignal): Promise<EmbeddingResponse>;
}
export type EmbeddingFailureCode = 'TIMEOUT' | 'RATE_LIMITED' | 'UPSTREAM_5XX' | 'UNAVAILABLE'
  | 'OUTPUT_INVALID' | 'BUDGET_EXHAUSTED' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'BUSY' | 'UNSETTLED';
export class EmbeddingFailure extends Error {
  constructor(readonly code: EmbeddingFailureCode) { super(code); }
}
