import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const containerSchema = z.object({
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.literal(true) }),
  NetworkSettings: z.object({ Ports: z.object({
    '5432/tcp': z.array(z.object({ HostIp: z.literal('127.0.0.1'), HostPort: z.literal('55432') })).length(1),
  }) }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
});

// Used before provisioning/setup and before each new test cleanup. No caller-supplied container IDs.
export async function ownedPostgres(signal?:AbortSignal): Promise<string> {
  try {
    const { stdout } = await execute('docker', [
      'compose', '--env-file', 'infra/.env', '-f', 'infra/compose.yaml', 'ps', '-q', 'postgres',
    ], { timeout: 10_000,...(signal?{signal}:{}) });
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(stdout.trim());
    const inspected = await execute('docker', ['inspect', id], { timeout: 10_000,...(signal?{signal}:{}) });
    const [info] = z.array(containerSchema).length(1).parse(JSON.parse(inspected.stdout) as unknown);
    if (!info || info.Config.Labels['com.docker.compose.project'] !== 'resume-studio'
      || info.Config.Labels['com.docker.compose.service'] !== 'postgres') throw new Error('ownership');
    const volume = info.Mounts.find(mount => mount.Destination === '/var/lib/postgresql/data');
    if (volume?.Type !== 'volume' || volume.Name !== 'resume-studio_postgres_data') throw new Error('volume');
    const inspectedVolume = await execute('docker', ['volume', 'inspect', volume.Name], { timeout: 10_000,...(signal?{signal}:{}) });
    const labels = z.array(z.object({ Labels: z.record(z.string(), z.string()) })).length(1)
      .parse(JSON.parse(inspectedVolume.stdout) as unknown)[0]?.Labels;
    if (labels?.['com.docker.compose.project'] !== 'resume-studio'
      || labels['com.docker.compose.volume'] !== 'postgres_data') throw new Error('volume ownership');
    return id;
  } catch {
    throw new Error('Resume Studio PostgreSQL ownership/port/volume verification failed.');
  }
}
