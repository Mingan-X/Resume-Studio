import { z } from 'zod';
export const modelUsageSchema = z.object({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(),
  costMicros: z.int().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
export const modelResponseSchema = z.object({ output: z.unknown(), usage: modelUsageSchema.nullable() }).strict();
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
