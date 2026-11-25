import { z } from 'zod';
import { ConfigValidationError } from '../../modules/config/app-config.js';

const databaseUrl = (username: string) => z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'postgresql:' && url.hostname === '127.0.0.1'
      && url.port === '55432' && url.pathname === '/resume_studio_checkpoint'
      && url.username === username && /^[a-f0-9]{48}$/.test(url.password)
      && !url.search && !url.hash;
  } catch { return false; }
});

const runtimeSchema = z.object({
  CHECKPOINT_DATABASE_URL: databaseUrl('resume_studio_checkpoint'),
  CHECKPOINT_SCHEMA: z.literal('langgraph'),
  CHECKPOINT_POOL_MAX: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(3)),
});
const setupSchema = z.object({ CHECKPOINT_SETUP_URL: databaseUrl('resume_studio_checkpoint_setup') });

export interface CheckpointConfig { databaseUrl: string; schema: 'langgraph'; poolMax: number }

function parseConfig<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(
    [...new Set(result.error.issues.map(issue => String(issue.path[0])))].sort(),
  );
  return result.data;
}

export function loadCheckpointConfig(env: NodeJS.ProcessEnv): CheckpointConfig {
  const value = parseConfig(runtimeSchema, env);
  return { databaseUrl: value.CHECKPOINT_DATABASE_URL, schema: value.CHECKPOINT_SCHEMA, poolMax: value.CHECKPOINT_POOL_MAX };
}

export function loadCheckpointSetupUrl(env: NodeJS.ProcessEnv): string {
  return parseConfig(setupSchema, env).CHECKPOINT_SETUP_URL;
}
