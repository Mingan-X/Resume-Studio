import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createDockerReadProxy } from '../../src/infrastructure/deployment/docker-read-proxy.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit } from '../../src/infrastructure/messaging/ownership.js';
import { ownedQdrant } from '../../src/infrastructure/vector/ownership.js';
import { assertObservabilityOwnership } from '../../src/infrastructure/observability/ownership.js';

await test('S3.3 real Docker CLI preserves existing ownership guards through the read-only gateway', { timeout: 120_000 }, async t => {
  const pg = await ownedPostgres(), rabbit = await ownedRabbit(), prior = process.env.DOCKER_HOST;
  const proxy = createDockerReadProxy(process.platform === 'win32' ? '\\\\.\\pipe\\dockerDesktopLinuxEngine' : '/var/run/docker.sock');
  const paths = new Set<string>(); proxy.on('request', req => paths.add(`${req.method} ${req.url?.split('?')[0]}`));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); const address = proxy.address();
  if (!address || typeof address === 'string') assert.fail();
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${address.port}`;
  try {
    assert.equal(await ownedPostgres(), pg); assert.equal(await ownedRabbit(), rabbit);
    await ownedQdrant(); await assertObservabilityOwnership(true);
    assert.ok([...paths].some(path => path.includes('/containers/'))); assert.ok([...paths].some(path => path.includes('/volumes/')));
  } finally {
    if (prior === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = prior;
    t.diagnostic(JSON.stringify({ gatewayPaths: [...paths] })); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
