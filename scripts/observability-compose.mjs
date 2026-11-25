import { execFileSync, spawn } from 'node:child_process';
import { z } from 'zod';

const compose = ['compose', '--env-file', 'infra/.env', '--env-file', 'infra/.env.observability',
  '-f', 'infra/compose.yaml', '-f', 'infra/compose.observability.yaml', '--profile', 'observability'];
const project = 'resume-studio';
const services = ['langfuse-web', 'langfuse-worker', 'langfuse-postgres', 'langfuse-redis', 'langfuse-clickhouse', 'langfuse-minio'];
const volumes = ['postgres_data', 'redis_data', 'clickhouse_data', 'clickhouse_logs', 'minio_data'];
const command = process.argv[2];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
const labelsSchema = z.record(z.string(), z.string());

try {
  if (!['up', 'stop', 'pull', 'status'].includes(command) || process.argv.length !== 3) throw new Error('command');
  // Existing instances and data volumes must have Compose ownership, including on first setup.
  const ids = docker([...compose, 'ps', '-a', '-q', ...services]).trim().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('id');
    const labels = labelsSchema.parse(JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', id])));
    if (labels['com.docker.compose.project'] !== project || !services.includes(labels['com.docker.compose.service'])) throw new Error('container ownership');
  }
  // Parse without printing expanded credentials. Legacy names are allowed only for
  // the explicitly migrated volumes and must retain their original Compose labels.
  const resolved = z.object({ volumes: z.record(z.string(), z.object({ name: z.string() })) })
    .parse(JSON.parse(docker([...compose, 'config', '--format', 'json'])));
  const missing = [];
  for (const key of volumes) {
    const name = resolved.volumes[`langfuse_${key}`]?.name;
    const fresh = `${project}_langfuse_${key}`, legacy = `resume-studio-observability_${key}`;
    if (name !== fresh && name !== legacy) throw new Error('unexpected volume mapping');
    const exists = docker(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']).trim();
    if (!exists) {
      if (name === legacy) throw new Error('missing migrated persistent volume');
      if (command === 'up') missing.push({ name, key });
      continue;
    }
    const labels = labelsSchema.parse(JSON.parse(docker(['volume', 'inspect', '--format', '{{json .Labels}}', name])));
    const expectedProject = name === legacy ? 'resume-studio-observability' : project;
    const expectedKey = name === legacy ? key : `langfuse_${key}`;
    if (labels['com.docker.compose.project'] !== expectedProject || labels['com.docker.compose.volume'] !== expectedKey) throw new Error('volume ownership');
    // A previous project's stopped containers may remain during migration, but two
    // database processes must never mount the same data volume concurrently.
    const users = docker(['ps', '-q', '--filter', `volume=${name}`]).trim().split(/\s+/).filter(Boolean);
    for (const id of users) {
      const owner = labelsSchema.parse(JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', id])));
      if (owner['com.docker.compose.project'] !== project || !services.includes(owner['com.docker.compose.service'])) throw new Error('volume already in use');
    }
  }
  const networks = docker(['network', 'ls', '--filter', `name=^${project}_observability$`, '--format', '{{.ID}}']).trim().split(/\s+/).filter(Boolean);
  for (const id of networks) {
    const labels = labelsSchema.parse(JSON.parse(docker(['network', 'inspect', '--format', '{{json .Labels}}', id])));
    if (labels['com.docker.compose.project'] !== project || labels['com.docker.compose.network'] !== 'observability') throw new Error('network ownership');
  }
  for (const { name, key } of missing) docker(['volume', 'create', '--label', `com.docker.compose.project=${project}`,
    '--label', `com.docker.compose.volume=langfuse_${key}`, name]);
  const args = command === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '240']
    : command === 'status' ? ['ps'] : [command];
  const child = spawn('docker', [...compose, ...args, ...services], { stdio: 'inherit',
    env: { ...process.env, COMPOSE_IGNORE_ORPHANS: 'true' } });
  child.once('error', () => { console.error('OBSERVABILITY_COMPOSE_FAILED'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch {
  // Docker/Compose errors can contain expanded secrets; only emit a safe code.
  console.error('OBSERVABILITY_PREFLIGHT_FAILED: check local credentials, Docker, and project resource ownership.');
  process.exitCode = 1;
}
