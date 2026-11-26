import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { InfrastructureConfig } from '../../src/infrastructure/config.js';

export const RECONCILIATION_MS = 15_000;
export const cleanupTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('docker'), url: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '56333'
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  }) }).strict(),
  z.object({ kind: z.literal('native-windows'), url: z.literal('http://127.0.0.1:6333'),
    executable: z.string().min(1), pid: z.int().positive(), started: z.string().min(1),
    size: z.int().positive(), mtimeMs: z.number().nonnegative() }).strict(),
]);
export const cleanupManifestSchema = z.object({
  schemaVersion: z.literal(1), project: z.literal('resume-studio'), service: z.literal('qdrant'),
  target: cleanupTargetSchema.optional(), // Older manifests without target refer to the project Docker instance.
  runId: z.uuid(), collection: z.string(), status: z.literal('CLEANUP_PENDING'),
  reason: z.enum(['CREATE_UNCONFIRMED', 'DELETE_UNCONFIRMED', 'OWNERSHIP_UNVERIFIED']),
  recordedAt: z.iso.datetime(),
}).strict().refine(value => value.collection === collectionForRun(value.runId));

export function collectionForRun(runId: string): string {
  return `s12_${z.uuid().parse(runId).replaceAll('-', '_')}`;
}

export interface CollectionCleanupApi {
  exists(collection: string, signal: AbortSignal): Promise<boolean>;
  remove(collection: string, signal: AbortSignal): Promise<void>;
}

export function collectionCleanupApi(config: Pick<InfrastructureConfig, 'qdrantUrl' | 'qdrantApiKey'>): CollectionCleanupApi {
  const headers = { 'api-key': config.qdrantApiKey };
  const endpoint = (collection: string) => `${config.qdrantUrl}/collections/${encodeURIComponent(collection)}`;
  return {
    async exists(collection, signal) {
      const response = await fetch(`${endpoint(collection)}/exists`, { headers, signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Qdrant existence check failed.'); }
      return z.object({ result: z.object({ exists: z.boolean() }) }).parse(await response.json()).result.exists;
    },
    async remove(collection, signal) {
      const response = await fetch(endpoint(collection), { method: 'DELETE', headers, signal, redirect: 'error' });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new Error('Qdrant exact collection deletion failed.');
    },
  };
}

export class CleanupPendingError extends Error {
  constructor(readonly manifestPath: string, readonly reason: z.infer<typeof cleanupManifestSchema>['reason']) {
    super(`QDRANT_CLEANUP_PENDING: ${reason}; retained ${manifestPath}`);
  }
}

export async function reconcileCollection(options: {
  runId: string;
  createConfirmed: boolean;
  api: CollectionCleanupApi;
  verifyOwnership: (signal: AbortSignal) => Promise<void>;
  manifestDirectory?: string;
  target?: z.infer<typeof cleanupTargetSchema>;
  // Tests shorten the observation window, never the real client's timeout.
  budgetMs?: number;
  pollMs?: number;
}): Promise<void> {
  const runId = z.uuid().parse(options.runId);
  const collection = collectionForRun(runId);
  const budget = options.budgetMs ?? RECONCILIATION_MS;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + budget;
  let observedCreation = options.createConfirmed;
  let deleteAttempted = false;
  let reason: z.infer<typeof cleanupManifestSchema>['reason'] = observedCreation ? 'DELETE_UNCONFIRMED' : 'CREATE_UNCONFIRMED';
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now())));

  while (Date.now() < deadline) {
    try {
      const exists = await options.api.exists(collection, signal());
      if (!exists && (options.createConfirmed || deleteAttempted) && observedCreation) return;
      if (exists) {
        observedCreation = true;
        reason = 'DELETE_UNCONFIRMED';
        try { await options.verifyOwnership(signal()); }
        catch { reason = 'OWNERSHIP_UNVERIFIED'; break; }
        if (Date.now() >= deadline) break;
        deleteAttempted = true;
        await options.api.remove(collection, signal());
        // Verify disappearance even if the DELETE response was lost on a later attempt.
        if (Date.now() < deadline && !await options.api.exists(collection, signal())) return;
      }
    } catch { /* A lost response is not evidence that creation/deletion did not happen. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(pollMs, remaining));
  }

  const directory = options.manifestDirectory ?? 'data/qdrant-cleanup';
  const manifest = cleanupManifestSchema.parse({ schemaVersion: 1, project: 'resume-studio', service: 'qdrant',
    target: options.target ?? { kind: 'docker', url: 'http://127.0.0.1:56333' },
    runId, collection, status: 'CLEANUP_PENDING', reason, recordedAt: new Date().toISOString() });
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${runId}.json`);
  // Immutable per-run evidence; never overwrite a previous unresolved cleanup request.
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  throw new CleanupPendingError(path, reason);
}
