import { execFileSync, spawn } from 'node:child_process';
import { z } from 'zod';

const compose = ['compose', '--env-file', 'infra/.env', '-f', 'infra/compose.yaml'];
const services = ['postgres', 'rabbitmq', 'qdrant'];
const command = process.argv[2];
try {
  if (!['up', 'stop'].includes(command) || process.argv.length !== 3) throw new Error('command');
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  const ids = docker([...compose, 'ps', '-a', '-q', ...services]).trim().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('id');
    const labels = z.record(z.string(), z.string()).parse(JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', id])));
    if (labels['com.docker.compose.project'] !== 'resume-studio' || !services.includes(labels['com.docker.compose.service'])) throw new Error('ownership');
  }
  const args = command === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '90'] : ['stop'];
  const child = spawn('docker', [...compose, ...args, ...services], { stdio: 'inherit',
    // Langfuse is intentionally defined in the optional overlay; never remove it as an orphan.
    env: { ...process.env, COMPOSE_IGNORE_ORPHANS: 'true' } });
  child.once('error', () => { console.error('INFRA_COMPOSE_FAILED'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch {
  console.error('INFRA_PREFLIGHT_FAILED: check local credentials, Docker, and project ownership.');
  process.exitCode = 1;
}
