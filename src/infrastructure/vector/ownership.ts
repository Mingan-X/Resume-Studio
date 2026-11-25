import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
export const qdrantContainerSchema = z.object({
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.literal(true) }),
  NetworkSettings: z.object({ Ports: z.object({
    '6333/tcp': z.array(z.object({ HostIp: z.literal('127.0.0.1'), HostPort: z.literal('56333') })).length(1),
  }) }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
});

export function validateQdrantOwnership(container: unknown, volume: unknown): void {
  const info = qdrantContainerSchema.parse(container);
  if (info.Config.Labels['com.docker.compose.project'] !== 'resume-studio'
    || info.Config.Labels['com.docker.compose.service'] !== 'qdrant') throw new Error('ownership');
  const storage = info.Mounts.find(mount => mount.Destination === '/qdrant/storage');
  if (storage?.Type !== 'volume' || storage.Name !== 'resume-studio_qdrant_data') throw new Error('mount');
  const labels = z.object({ Name: z.literal('resume-studio_qdrant_data'), Labels: z.record(z.string(), z.string()) }).parse(volume).Labels;
  if (labels['com.docker.compose.project'] !== 'resume-studio'
    || labels['com.docker.compose.volume'] !== 'qdrant_data') throw new Error('volume');
}

export async function ownedQdrant(signal?: AbortSignal): Promise<void> {
  const options = { timeout: 5_000, ...(signal ? { signal } : {}) };
  try {
    const result = await execute('docker', ['compose', '--env-file', 'infra/.env', '-f', 'infra/compose.yaml',
      'ps', '-q', 'qdrant'], options);
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(result.stdout.trim());
    const inspected = await execute('docker', ['inspect', id], options);
    const volume = await execute('docker', ['volume', 'inspect', 'resume-studio_qdrant_data'], options);
    validateQdrantOwnership(z.array(z.unknown()).length(1).parse(JSON.parse(inspected.stdout) as unknown)[0],
      z.array(z.unknown()).length(1).parse(JSON.parse(volume.stdout) as unknown)[0]);
  } catch { throw new Error('Qdrant project/service/port/volume ownership verification failed.'); }
}
