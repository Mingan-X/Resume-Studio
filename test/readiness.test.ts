import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadinessService } from '../src/modules/health/readiness.service.js';
import { loadConfig } from '../src/modules/config/app-config.js';

await test('S3.3 readiness requires both dependencies and coalesces simultaneous probes without exposing errors', async () => {
  for (const failed of ['database', 'broker', 'none']) {
    let database = 0, broker = 0;
    const service = new ReadinessService(async () => { database++; if (failed === 'database') throw new Error('secret SQL'); },
      async () => { broker++; if (failed === 'broker') throw new Error('secret AMQP'); });
    assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => service.check())), Array(20).fill(failed === 'none'));
    assert.equal(database, 1); assert.equal(broker, 1); assert.equal(await service.check(), failed === 'none');
    assert.equal(database, 1); assert.equal(broker, 1);
  }
});
await test('S3.3 readiness is opt-in and retains project connection constraints', () => {
  const env = { APP_ENV: 'test', HTTP_PORT: '3000' };
  assert.equal(loadConfig('api', env).readiness, undefined);
  assert.throws(() => loadConfig('api', { ...env, READINESS_ENABLED: 'true' }));
  assert.throws(() => loadConfig('api', { ...env, READINESS_ENABLED: 'yes' }));
});
