import { z } from 'zod';
import { ConfigValidationError } from '../../modules/config/app-config.js';

const boundedInteger = (min: number, max: number, fallback: string) =>
  z.string().regex(/^\d+$/).default(fallback).transform(Number).pipe(z.int().min(min).max(max));
const schema = z.object({
  OBSERVABILITY_ENABLED: z.enum(['true', 'false']).default('false'),
  LANGFUSE_BASE_URL: z.literal('http://127.0.0.1:53000'),
  LANGFUSE_PUBLIC_KEY: z.string().regex(/^pk-lf-[a-f0-9-]{36}$/),
  LANGFUSE_SECRET_KEY: z.string().regex(/^sk-lf-[a-f0-9]{64}$/),
  OBSERVABILITY_MAX_QUEUE_SIZE: boundedInteger(8, 512, '128'),
  OBSERVABILITY_EXPORT_TIMEOUT_MS: boundedInteger(100, 5000, '2000'),
});

export type ObservabilityConfig = { enabled: false } | {
  enabled: true; baseUrl: string; publicKey: string; secretKey: string;
  maxQueueSize: number; exportTimeoutMs: number;
};

export function loadObservabilityConfig(env: NodeJS.ProcessEnv): ObservabilityConfig {
  if (env.OBSERVABILITY_ENABLED === undefined || env.OBSERVABILITY_ENABLED === 'false') return { enabled: false };
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(
    [...new Set(result.error.issues.map(issue => String(issue.path[0])))].sort(),
  );
  return { enabled: true, baseUrl: result.data.LANGFUSE_BASE_URL, publicKey: result.data.LANGFUSE_PUBLIC_KEY,
    secretKey: result.data.LANGFUSE_SECRET_KEY, maxQueueSize: result.data.OBSERVABILITY_MAX_QUEUE_SIZE,
    exportTimeoutMs: result.data.OBSERVABILITY_EXPORT_TIMEOUT_MS };
}
