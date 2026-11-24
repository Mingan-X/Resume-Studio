import { z } from 'zod';
import { ConfigValidationError } from '../modules/config/app-config.js';

const localUrl = (protocols: string[], pathname?: string, port?: string) => z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && (!port || url.port === port)
      && (!pathname || (url.pathname === pathname && url.username === 'resume_studio_test'));
  } catch { return false; }
});

const schema = z.object({
  INFRA_TEST_SCOPE: z.literal('resume-studio-s12-test'),
  DATABASE_URL: localUrl(['postgresql:'], '/resume_studio_s12_test', '55432'),
  RABBITMQ_URL: localUrl(['amqp:'], '/resume-studio-s12-test', '55672'),
  QDRANT_URL: localUrl(['http:'], undefined, '56333').refine(value => {
    try {
      const u = new URL(value);
      return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
    } catch { return false; }
  }),
  QDRANT_API_KEY: z.string().min(24),
});

export interface InfrastructureConfig {
  databaseUrl: string;
  rabbitmqUrl: string;
  qdrantUrl: string;
  qdrantApiKey: string;
}

export function loadInfrastructureConfig(env: NodeJS.ProcessEnv): InfrastructureConfig {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(
    [...new Set(result.error.issues.map(issue => String(issue.path[0])))].sort(),
  );
  return {
    databaseUrl: result.data.DATABASE_URL,
    rabbitmqUrl: result.data.RABBITMQ_URL,
    qdrantUrl: result.data.QDRANT_URL,
    qdrantApiKey: result.data.QDRANT_API_KEY,
  };
}
