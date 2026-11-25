import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { CleanupPendingError, cleanupManifestSchema, collectionCleanupApi, collectionForRun, reconcileCollection } from './support/qdrant-cleanup.js';
import { validateQdrantOwnership } from '../src/infrastructure/vector/ownership.js';

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return { url: `http://127.0.0.1:${port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

await test('timed-out creation is reconciled after the first absence and deletes only the exact run collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-qdrant-cleanup-'));
  const runId = randomUUID(), name = collectionForRun(runId);
  const collections = new Set(['unrelated-collection']);
  const events: string[] = [];
  let creationTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let absentReported = false;
  const controller = new AbortController();
  const server = await startServer((request, response) => {
    if (request.method === 'PUT' && request.url === `/collections/${name}`) {
      events.push('create-received');
      // The server still owns a pending create after the client abandons its HTTP request.
      timeoutTimer = setTimeout(() => controller.abort(new Error('Synthetic client timeout')), 20);
      return;
    }
    if (request.method === 'GET' && request.url === `/collections/${name}/exists`) {
      const exists = collections.has(name);
      events.push(exists ? 'exists-true' : 'exists-false');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { exists } }));
      if (!absentReported) {
        absentReported = true;
        creationTimer = setTimeout(() => { collections.add(name); events.push('late-create'); }, 50);
      }
      return;
    }
    if (request.method === 'DELETE' && request.url === `/collections/${name}`) {
      events.push('delete-exact'); collections.delete(name); response.end('{}'); return;
    }
    response.writeHead(400); response.end('{}');
  });
  try {
    await assert.rejects(fetch(`${server.url}/collections/${name}`, { method: 'PUT', signal: controller.signal }));
    events.push('client-timeout');
    await reconcileCollection({ runId, createConfirmed: false,
      api: collectionCleanupApi({ qdrantUrl: server.url, qdrantApiKey: 'synthetic-key' }),
      verifyOwnership: async () => { events.push('ownership-checked'); },
      manifestDirectory: directory, budgetMs: 1500, pollMs: 10 });
    assert.ok(events.indexOf('client-timeout') < events.indexOf('exists-false'));
    assert.ok(events.indexOf('exists-false') < events.indexOf('late-create'));
    assert.ok(events.indexOf('late-create') < events.indexOf('ownership-checked'));
    assert.ok(events.indexOf('ownership-checked') < events.indexOf('delete-exact'));
    assert.deepEqual([...collections], ['unrelated-collection']);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    clearTimeout(creationTimer); clearTimeout(timeoutTimer);
    await server.close(); await rm(directory, { recursive: true });
  }
});

await test('unconfirmed creation keeps a validated per-run manifest and fails after its finite reconciliation window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-qdrant-pending-'));
  const runId = randomUUID();
  let queries = 0, deletes = 0;
  const server = await startServer((request, response) => {
    if (request.method === 'DELETE') deletes++;
    else queries++;
    response.end('{"result":{"exists":false}}');
  });
  try {
    const started = performance.now();
    await assert.rejects(reconcileCollection({ runId, createConfirmed: false,
      api: collectionCleanupApi({ qdrantUrl: server.url, qdrantApiKey: 'synthetic-key' }),
      verifyOwnership: async () => { throw new Error('Deletion should not be attempted.'); },
      manifestDirectory: directory, budgetMs: 100, pollMs: 10 }), CleanupPendingError);
    assert.ok(performance.now() - started < 1500);
    assert.ok(queries >= 2);
    assert.equal(deletes, 0);
    const manifest = cleanupManifestSchema.parse(JSON.parse(await readFile(join(directory, `${runId}.json`), 'utf8')) as unknown);
    assert.equal(manifest.collection, collectionForRun(runId));
    assert.equal(manifest.reason, 'CREATE_UNCONFIRMED');
    assert.equal(manifest.status, 'CLEANUP_PENDING');
    assert.equal(cleanupManifestSchema.safeParse({ ...manifest, collection: 's12_someone_else' }).success, false);
  } finally { await server.close(); await rm(directory, { recursive: true }); }
});

await test('ownership rejection prevents deletion and leaves exact cleanup evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-qdrant-owner-'));
  const runId = randomUUID();
  let deletes = 0;
  try {
    await assert.rejects(reconcileCollection({ runId, createConfirmed: true,
      api: { exists: async () => true, remove: async () => { deletes++; } },
      verifyOwnership: async () => { throw new Error('Foreign instance.'); }, manifestDirectory: directory }), CleanupPendingError);
    assert.equal(deletes, 0);
    const manifest = cleanupManifestSchema.parse(JSON.parse(await readFile(join(directory, `${runId}.json`), 'utf8')) as unknown);
    assert.equal(manifest.reason, 'OWNERSHIP_UNVERIFIED');
  } finally { await rm(directory, { recursive: true }); }
});

await test('Qdrant ownership requires matching project, service, loopback port and volume labels', () => {
  const container = { Config: { Labels: { 'com.docker.compose.project': 'resume-studio', 'com.docker.compose.service': 'qdrant' } },
    State: { Running: true }, NetworkSettings: { Ports: { '6333/tcp': [{ HostIp: '127.0.0.1', HostPort: '56333' }] } },
    Mounts: [{ Type: 'volume', Name: 'resume-studio_qdrant_data', Destination: '/qdrant/storage' }] };
  const volume = { Name: 'resume-studio_qdrant_data', Labels: { 'com.docker.compose.project': 'resume-studio', 'com.docker.compose.volume': 'qdrant_data' } };
  validateQdrantOwnership(container, volume);
  for (const key of ['com.docker.compose.project', 'com.docker.compose.service'] as const) {
    assert.throws(() => validateQdrantOwnership({ ...container, Config: { Labels: { ...container.Config.Labels, [key]: 'foreign' } } }, volume));
  }
  assert.throws(() => validateQdrantOwnership({ ...container, NetworkSettings: { Ports: { '6333/tcp': [{ HostIp: '0.0.0.0', HostPort: '56333' }] } } }, volume));
  assert.throws(() => validateQdrantOwnership({ ...container, NetworkSettings: { Ports: { '6333/tcp': [{ HostIp: '127.0.0.1', HostPort: '6333' }] } } }, volume));
  assert.throws(() => validateQdrantOwnership(container, { ...volume, Labels: { ...volume.Labels, 'com.docker.compose.project': 'foreign' } }));
  assert.throws(() => validateQdrantOwnership(container, { ...volume, Labels: { ...volume.Labels, 'com.docker.compose.volume': 'foreign' } }));
  assert.throws(() => validateQdrantOwnership({ ...container, Mounts: [{ ...container.Mounts[0], Name: 'foreign' }] }, volume));
});
