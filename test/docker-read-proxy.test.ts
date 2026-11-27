import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createDockerReadProxy } from '../src/infrastructure/deployment/docker-read-proxy.js';

await test('S3.3 ownership gateway denies mutations, foreign resources and secrets while retaining verifiable metadata', async () => {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\resume-ownership-${randomUUID()}` : join(tmpdir(), `resume-${randomUUID()}.sock`);
  const id = 'a'.repeat(64); let calls = 0;
  const labels = { 'com.docker.compose.project': 'resume-studio', 'com.docker.compose.service': 'postgres' };
  const daemon = createServer((req, res) => {
    calls++; const path = req.url?.split('?')[0];
    const payload = path === '/version' ? { ApiVersion: '1.53', Os: 'linux' } : path === '/containers/json' ?
      [{ Id: id, Labels: labels }, { Id: 'b'.repeat(64), Labels: { ...labels, 'com.docker.compose.project': 'other' } }] :
      { Id: id, Config: { Labels: req.url?.includes('bbbb') ? { ...labels, 'com.docker.compose.project': 'other' } : labels,
        Env: ['SECRET=must-not-escape'] }, State: { Running: true, Health: { Status: 'healthy', Log: [{ Output: 'SECRET-health-output' }] } }, NetworkSettings: {}, Mounts: [], LogPath: 'secret-path' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });
  daemon.listen(socket); await once(daemon, 'listening');
  const proxy = createDockerReadProxy(socket); proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const address = proxy.address(); if (!address || typeof address === 'string') assert.fail();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const ping = await fetch(`${url}/_ping`, { method: 'HEAD' }); assert.equal(ping.status, 200); assert.equal(ping.headers.get('api-version'), '1.53');
    const list = await (await fetch(`${url}/v1.53/containers/json`)).json(); assert.deepEqual(list, [{ Id: id, Labels: labels }]);
    const filters = encodeURIComponent(JSON.stringify({ label: { 'com.docker.compose.project=resume-studio': true, 'com.docker.compose.service=postgres': true } }));
    assert.deepEqual(await (await fetch(`${url}/v1.53/containers/json?filters=${filters}`)).json(), list);
    const info = await (await fetch(`${url}/containers/${id}/json`)).text();
    assert.match(info, /resume-studio/); assert.doesNotMatch(info, /SECRET|Env|LogPath|secret-path/);
    assert.equal((await fetch(`${url}/containers/${'b'.repeat(64)}/json`)).status, 503);
    const before = calls;
    for (const [path, method] of [[`/containers/${id}/stop`, 'POST'], ['/containers/json', 'POST'], [`/containers/${id}/logs`, 'GET'],
      [`/containers/${id}/archive`, 'GET'], ['/exec', 'POST'], ['/images/json', 'GET']] as const) {
      const response = await fetch(url + path, { method }); assert.equal(response.status, 403); await response.body?.cancel();
    }
    assert.equal(calls, before);
  } finally {
    proxy.closeAllConnections(); daemon.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve())); await new Promise<void>(resolve => daemon.close(() => resolve()));
  }
});
