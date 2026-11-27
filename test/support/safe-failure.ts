import { z } from 'zod';

export const safeFailureSchema = z.object({ category: z.enum(['database', 'lease', 'schema', 'other']),
  code: z.string().regex(/^(P\d{4}|[0-9A-Z]{5}|UNKNOWN)$/),
  reason: z.enum(['connection-timeout', 'connection-closed', 'operation-timeout', 'transaction-timeout', 'statement-timeout', 'abort', 'lease', 'schema', 'unknown']),
}).strict();

// Inspect bounded causes; emit only enums/codes, never the error text, stack or config.
export function safeFailure(error: unknown) {
  let current = error;
  let result: z.infer<typeof safeFailureSchema> = { category: 'other', code: 'UNKNOWN', reason: 'unknown' };
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);
    const parsed = z.object({ name: z.string().optional(), message: z.string().optional(), code: z.string().optional(),
      cause: z.unknown().optional() }).safeParse(current);
    if (!parsed.success) break;
    const { name = '', message = '', code, cause } = parsed.data;
    const category = name.includes('Prisma') || name === 'DatabaseError' || name === 'DriverAdapterError' ? 'database'
      : message === 'TASK_EXECUTION_LEASE_LOST' ? 'lease' : name === 'ZodError' ? 'schema' : 'other';
    const reason = /connection.*timeout|timeout.*connect/i.test(message) ? 'connection-timeout'
      : /connection terminated|connection.*closed|socket hang up/i.test(message) ? 'connection-closed'
      : /transaction.*timed out|transaction.*timeout/i.test(message) ? 'transaction-timeout' : code === 'P1008' ? 'operation-timeout'
      : code === '57014' ? 'statement-timeout' : name === 'AbortError' || name === 'TimeoutError' ? 'abort'
      : category === 'lease' ? 'lease' : category === 'schema' ? 'schema' : 'unknown';
    result = { category: result.category === 'other' ? category : result.category,
      code: result.code === 'UNKNOWN' && code && /^(P\d{4}|[0-9A-Z]{5})$/.test(code) ? code : result.code,
      reason: result.reason === 'unknown' ? reason : result.reason };
    current = cause;
  }
  return safeFailureSchema.parse(result);
}
