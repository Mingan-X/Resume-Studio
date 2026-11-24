import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const root = new URL('../infra/', import.meta.url);
await mkdir(root, { recursive: true });
const password = () => randomBytes(24).toString('hex');
const postgres = password(), rabbit = password(), qdrant = password();
const content = [
  '# Generated local-only infrastructure credentials. Never commit this file.',
  `POSTGRES_PASSWORD=${postgres}`,
  `POSTGRES_ADMIN_PASSWORD=${password()}`,
  `RABBITMQ_PASSWORD=${rabbit}`,
  `QDRANT_API_KEY=${qdrant}`,
  `DATABASE_URL=postgresql://resume_studio_test:${postgres}@127.0.0.1:55432/resume_studio_s12_test`,
  `RABBITMQ_URL=amqp://resume_studio_test:${rabbit}@127.0.0.1:55672/resume-studio-s12-test?heartbeat=10`,
  'QDRANT_URL=http://127.0.0.1:56333',
  'INFRA_TEST_SCOPE=resume-studio-s12-test',
  '',
].join('\n');
try {
  await writeFile(new URL('.env', root), content, { flag: 'wx', mode: 0o600 });
  console.log('Created infra/.env with generated credentials; root .env was not changed.');
} catch (error) {
  if (error?.code !== 'EEXIST') {
    console.error('Could not create infrastructure configuration.');
    process.exitCode = 1;
  } else {
    console.log('infra/.env already exists; preserved without changes.');
  }
}
