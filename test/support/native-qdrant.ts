import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { InfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedQdrant } from '../../src/infrastructure/vector/ownership.js';
import { cleanupTargetSchema } from './qdrant-cleanup.js';

const execute = promisify(execFile);
const nativeSchema = z.object({
  QDRANT_TEST_TARGET: z.literal('native-windows'), QDRANT_NATIVE_ROOT: z.string().min(3),
  QDRANT_NATIVE_URL: z.literal('http://127.0.0.1:6333'), QDRANT_NATIVE_API_KEY: z.string().optional(),
});
const processSchema = z.object({ pid: z.int().positive(), executable: z.string(), started: z.string() });

// Explicit test-only alternative authorized by the maintainer. Normal application config stays Docker-only.
export async function qdrantTestTarget(baseline: InfrastructureConfig, env: NodeJS.ProcessEnv = process.env) {
  if (!env.QDRANT_TEST_TARGET) return { config: baseline, verify: ownedQdrant, kind: 'docker',
    cleanupTarget: cleanupTargetSchema.parse({ kind: 'docker', url: baseline.qdrantUrl }) };
  const config = nativeSchema.parse(env);
  if (process.platform !== 'win32') throw new Error('Native Qdrant verification requires Windows.');
  const executable = await realpath(resolve(config.QDRANT_NATIVE_ROOT, 'qdrant.exe'));
  const script = String.raw`
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 6333 -ErrorAction Stop)
$ids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ids.Count -ne 1) { throw 'Ambiguous listener' }
$p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ids[0])
if ($p.Name -ne 'qdrant.exe') { throw 'Wrong executable' }
@{pid=[int]$p.ProcessId; executable=$p.ExecutablePath; started=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress
`;
  const inspect = async (signal?: AbortSignal) => {
    const response = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { timeout: 10_000, ...(signal ? { signal } : {}) });
    const state = processSchema.parse(JSON.parse(response.stdout.trim()) as unknown);
    if ((await realpath(state.executable)).toLowerCase() !== executable.toLowerCase()) throw new Error('Native Qdrant path mismatch.');
    const file = await stat(executable);
    return { ...state, size: file.size, mtimeMs: file.mtimeMs };
  };
  const initial = await inspect();
  const verify = async (signal?: AbortSignal) => {
    const current = await inspect(signal);
    if (current.pid !== initial.pid || current.started !== initial.started || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) throw new Error('Native Qdrant process changed.');
  };
  await verify();
  return { config: { ...baseline, qdrantUrl: config.QDRANT_NATIVE_URL, qdrantApiKey: config.QDRANT_NATIVE_API_KEY ?? '' }, verify, kind: 'native-windows',
    cleanupTarget: cleanupTargetSchema.parse({ kind: 'native-windows', url: config.QDRANT_NATIVE_URL, ...initial, executable }) };
}
