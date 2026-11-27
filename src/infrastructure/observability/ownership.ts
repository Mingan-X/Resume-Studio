import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
export const observabilityCompose = ['compose', '--env-file', 'infra/.env', '--env-file', 'infra/.env.observability',
  '-f', 'infra/compose.yaml', '-f', 'infra/compose.observability.yaml', '--profile', 'observability'];
const project = 'resume-studio';
const expectedMounts: Record<string, Record<string, string>> = {
  'langfuse-web': {}, 'langfuse-worker': {},
  'langfuse-postgres': { '/var/lib/postgresql/data': 'postgres_data' },
  'langfuse-redis': { '/data': 'redis_data' },
  'langfuse-clickhouse': { '/var/lib/clickhouse': 'clickhouse_data', '/var/log/clickhouse-server': 'clickhouse_logs' },
  'langfuse-minio': { '/data': 'minio_data' },
};
const inspectSchema = z.array(z.object({
  State: z.object({ Running: z.boolean(), Health: z.object({ Status: z.string() }).optional() }),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  NetworkSettings: z.object({ Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()),
    Networks: z.record(z.string(), z.unknown()) }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
})).length(1);

export async function assertObservabilityOwnership(requireHealthy = false,signal?:AbortSignal): Promise<void> {
  const options={timeout:10000,...(signal?{signal}:{})};
  try {
    const resolved = await execute('docker', [...observabilityCompose, 'config', '--format', 'json'], options);
    const volumes = z.object({ volumes: z.record(z.string(), z.object({ name: z.string() })) })
      .parse(JSON.parse(resolved.stdout) as unknown).volumes;
    for (const [service, mounts] of Object.entries(expectedMounts)) {
      const result = await execute('docker', [...observabilityCompose, 'ps', '-a', '-q', service], options);
      const id = z.string().regex(/^[a-f0-9]{64}$/).parse(result.stdout.trim());
      const inspected = await execute('docker', ['inspect', id], options);
      const info = inspectSchema.parse(JSON.parse(inspected.stdout) as unknown)[0];
      if (!info || info.Config.Labels['com.docker.compose.project'] !== project
        || info.Config.Labels['com.docker.compose.service'] !== service
        || Object.keys(info.NetworkSettings.Networks).length !== 1
        || !(`${project}_observability` in info.NetworkSettings.Networks)) throw new Error('ownership');
      if (requireHealthy && (!info.State.Running || info.State.Health?.Status !== 'healthy')) throw new Error('not ready');
      for (const [port, bindings] of Object.entries(info.NetworkSettings.Ports)) {
        for (const binding of bindings ?? []) {
          const expected = service === 'langfuse-web' && port === '3000/tcp' ? '53000'
            : service === 'langfuse-minio' && port === '9000/tcp' ? '59090' : undefined;
          if (!expected || binding.HostIp !== '127.0.0.1' || binding.HostPort !== expected) throw new Error('binding');
        }
      }
      if (requireHealthy) {
        const port = service === 'langfuse-web' ? '3000/tcp' : service === 'langfuse-minio' ? '9000/tcp' : undefined;
        if (port && info.NetworkSettings.Ports[port]?.length !== 1) throw new Error('missing binding');
      }
      if (info.Mounts.length !== Object.keys(mounts).length) throw new Error('unexpected mounts');
      for (const mount of info.Mounts) {
        const key = mounts[mount.Destination];
        const configuredName = key ? volumes[`langfuse_${key}`]?.name : undefined;
        const legacy = `resume-studio-observability_${key}`;
        if (mount.Type !== 'volume' || !mount.Name || !key || mount.Name !== configuredName
          || (configuredName !== `${project}_langfuse_${key}` && configuredName !== legacy)) throw new Error('mount');
        const result = await execute('docker', ['volume', 'inspect', mount.Name], options);
        const labels = z.array(z.object({ Labels: z.record(z.string(), z.string()) })).length(1)
          .parse(JSON.parse(result.stdout) as unknown)[0]?.Labels;
        const expectedProject = configuredName === legacy ? 'resume-studio-observability' : project;
        const expectedKey = configuredName === legacy ? key : `langfuse_${key}`;
        if (labels?.['com.docker.compose.project'] !== expectedProject
          || labels['com.docker.compose.volume'] !== expectedKey) throw new Error('volume');
      }
    }
    const network = await execute('docker', ['network', 'inspect', `${project}_observability`], options);
    const labels = z.array(z.object({ Labels: z.record(z.string(), z.string()) })).length(1)
      .parse(JSON.parse(network.stdout) as unknown)[0]?.Labels;
    if (labels?.['com.docker.compose.project'] !== project || labels['com.docker.compose.network'] !== 'observability') throw new Error('network');
  } catch { throw new Error('Langfuse project/container/network/volume ownership verification failed.'); }
}
