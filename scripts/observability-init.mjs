import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const secret = () => randomBytes(32).toString('hex');
const content = [
  '# Local Langfuse credentials. Never commit or paste this file into logs.',
  'OBSERVABILITY_ENABLED=true',
  'LANGFUSE_BASE_URL=http://127.0.0.1:53000',
  `LANGFUSE_PUBLIC_KEY=pk-lf-${randomUUID()}`,
  `LANGFUSE_SECRET_KEY=sk-lf-${secret()}`,
  `LANGFUSE_POSTGRES_PASSWORD=${secret()}`,
  `LANGFUSE_CLICKHOUSE_PASSWORD=${secret()}`,
  `LANGFUSE_REDIS_PASSWORD=${secret()}`,
  `LANGFUSE_S3_SECRET=${secret()}`,
  `LANGFUSE_SALT=${secret()}`,
  `LANGFUSE_ENCRYPTION_KEY=${secret()}`,
  `LANGFUSE_NEXTAUTH_SECRET=${secret()}`,
  'LANGFUSE_INIT_USER_EMAIL=admin@resume-studio.local',
  `LANGFUSE_INIT_USER_PASSWORD=${secret()}`,
  'OBSERVABILITY_MAX_QUEUE_SIZE=128',
  'OBSERVABILITY_EXPORT_TIMEOUT_MS=2000',
  '',
].join('\n');
try {
  await writeFile(new URL('../infra/.env.observability', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created infra/.env.observability with local credentials; no secrets were printed.');
} catch (error) {
  if (error?.code === 'EEXIST') console.log('Existing observability configuration preserved.');
  else { console.error('Observability configuration could not be created.'); process.exitCode = 1; }
}
