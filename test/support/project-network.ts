import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
export async function verifyProjectNetwork(containerId: string): Promise<string> {
  const id = z.string().regex(/^[a-f0-9]{64}$/).parse(containerId);
  try {
    const attached = await execute('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', id], { timeout: 10_000 });
    const networks = z.record(z.string(), z.object({ NetworkID: z.string().regex(/^[a-f0-9]{64}$/) }))
      .parse(JSON.parse(attached.stdout) as unknown);
    const network = networks['resume-studio_default'];
    if (Object.keys(networks).length !== 1 || !network) throw new Error('network');
    const raw = await execute('docker', ['network', 'inspect', network.NetworkID], { timeout: 10_000 });
    const [info] = z.array(z.object({ Id: z.string(), Name: z.literal('resume-studio_default'),
      Labels: z.record(z.string(), z.string()), Containers: z.record(z.string(), z.unknown()),
    })).length(1).parse(JSON.parse(raw.stdout) as unknown);
    if (!info || info.Id !== network.NetworkID || info.Labels['com.docker.compose.project'] !== 'resume-studio' ||
        info.Labels['com.docker.compose.network'] !== 'default' || !Object.hasOwn(info.Containers, id)) throw new Error('network');
    return network.NetworkID;
  } catch { throw new Error('PROJECT_NETWORK_OWNERSHIP_FAILED'); }
}
