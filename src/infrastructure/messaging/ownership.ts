import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const labels = z.record(z.string(), z.string());
const port = (value: string) => z.array(z.object({ HostIp: z.literal('127.0.0.1'), HostPort: z.literal(value) })).length(1);
export function validateRabbitOwnership(container: unknown, volume: unknown): void {
  const info = z.object({
    Config: z.object({ Labels: labels }), State: z.object({ Running: z.literal(true) }),
    NetworkSettings: z.object({ Ports: z.object({ '5672/tcp': port('55672'), '15672/tcp': port('55673') }) }),
    Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
  }).parse(container);
  if (info.Config.Labels['com.docker.compose.project'] !== 'resume-studio'
    || info.Config.Labels['com.docker.compose.service'] !== 'rabbitmq') throw new Error('ownership');
  const mount = info.Mounts.find(item => item.Destination === '/var/lib/rabbitmq');
  if (mount?.Type !== 'volume' || mount.Name !== 'resume-studio_rabbitmq_data') throw new Error('mount');
  const data = z.object({ Name: z.literal('resume-studio_rabbitmq_data'), Labels: labels }).parse(volume);
  if (data.Labels['com.docker.compose.project'] !== 'resume-studio'
    || data.Labels['com.docker.compose.volume'] !== 'rabbitmq_data') throw new Error('volume');
}

export async function ownedRabbit(): Promise<string> {
  try {
    const result = await execute('docker', ['compose', '--env-file', 'infra/.env', '-f', 'infra/compose.yaml',
      'ps', '-q', 'rabbitmq'], { timeout: 10_000 });
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(result.stdout.trim());
    const container = await execute('docker', ['inspect', id], { timeout: 10_000 });
    const volume = await execute('docker', ['volume', 'inspect', 'resume-studio_rabbitmq_data'], { timeout: 10_000 });
    validateRabbitOwnership(z.array(z.unknown()).length(1).parse(JSON.parse(container.stdout) as unknown)[0],
      z.array(z.unknown()).length(1).parse(JSON.parse(volume.stdout) as unknown)[0]);
    return id;
  } catch { throw new Error('RabbitMQ project/service/port/volume ownership verification failed.'); }
}

// Only non-secret, structured administrative arguments; never return raw process exceptions.
export async function rabbitAdmin(args: string[]): Promise<unknown> {
  const id = await ownedRabbit();
  try {
    const result = await execute('docker', ['exec', id, 'rabbitmqctl', '-q', ...args], { timeout: 20_000 });
    return result.stdout.trim() ? JSON.parse(result.stdout) as unknown : null;
  } catch { throw new Error('RabbitMQ project administration failed.'); }
}
