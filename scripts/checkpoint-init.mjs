import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const credential = () => randomBytes(24).toString('hex');
const runtime = credential(), setup = credential();
const content = [
  '# Generated local Checkpointer credentials. Never commit this file.',
  `CHECKPOINT_DATABASE_URL=postgresql://resume_studio_checkpoint:${runtime}@127.0.0.1:55432/resume_studio_checkpoint`,
  `CHECKPOINT_SETUP_URL=postgresql://resume_studio_checkpoint_setup:${setup}@127.0.0.1:55432/resume_studio_checkpoint`,
  'CHECKPOINT_SCHEMA=langgraph',
  'CHECKPOINT_POOL_MAX=3',
  '',
].join('\n');
try {
  await writeFile(new URL('../infra/.env.checkpoint', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created infra/.env.checkpoint; existing infrastructure credentials were preserved.');
} catch (error) {
  if (error?.code === 'EEXIST') console.log('infra/.env.checkpoint already exists; preserved without changes.');
  else { console.error('Could not create Checkpointer configuration.'); process.exitCode = 1; }
}
