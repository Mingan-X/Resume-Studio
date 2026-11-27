import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { indexCollectionSchema } from '../src/contracts/job-index.js';
import { indexCollectionName } from '../src/modules/recall/job-chunks.js';
import { JobIndexVector } from '../src/infrastructure/vector/job-index.vector.js';
import { isRetryable } from '../src/infrastructure/consumer/failure.js';

await test('S2.3 Qdrant HTTP failures are bounded, classified, never retried inside the adapter and ownership gates mutation', async t => {
  const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId: randomUUID(),
    embeddingVersion: 'fixture-v1', indexVersion: 'fixture-v1', dimensions: 8, provenance: 'synthetic',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1' });
  let mode: 'healthy' | 'rate' | 'failure' | 'slow' | 'foreign' = 'healthy', requests = 0, mutations = 0;
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((request, response) => {
    requests++; if (request.method !== 'GET') mutations++;
    if (mode === 'rate') { response.writeHead(429).end(); return; }
    if (mode === 'failure') { response.writeHead(503).end(); return; }
    if (mode === 'slow') {
      const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200).end('{}'); }, 1000); timers.add(timer); return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/') { response.end(JSON.stringify({ version: '1.20.2' })); return; }
    const metadata = mode === 'foreign' ? { ...spec, ownerId: randomUUID() } : spec;
    response.end(JSON.stringify({ status: 'ok', result: { config: { metadata, params: { vectors: { size: 8, distance: 'Cosine' } } } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const vector = new JobIndexVector({ url: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' }, () => Promise.resolve());
  const call = () => ({ signal: AbortSignal.timeout(1000), deadline: Date.now() + 1000 });
  await vector.verify(spec, call());
  for (const [scenario, code] of [['rate', 'RATE_LIMITED'], ['failure', 'UPSTREAM_5XX']] as const) {
    mode = scenario; requests = 0;
    await assert.rejects(vector.verify(spec, call()), { message: code });
    assert.equal(requests, 1); assert.equal(isRetryable(code), true);
  }
  mode = 'slow'; requests = 0;
  await assert.rejects(vector.verify(spec, { signal: new AbortController().signal, deadline: Date.now() + 40 }), /DEADLINE_EXCEEDED/);
  assert.equal(requests, 1);
  mode = 'foreign'; mutations = 0;
  await assert.rejects(vector.remove(spec, call())); assert.equal(mutations, 0);
  mode = 'healthy'; requests = 0;
  const denied = new JobIndexVector({ url: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' }, () => Promise.reject(new Error('ownership')));
  await assert.rejects(denied.ensure(spec, call()), /ownership/); assert.equal(requests, 0);
  assert.match(indexCollectionName(spec), /^rs_jobs_/);
});
