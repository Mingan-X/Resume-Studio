import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigValidationError, loadConfig } from '../src/modules/config/app-config.js';

await test('API configuration converts the port and excludes unrelated secrets', () => {
  const result = loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000', API_KEY: 'private-marker' });
  assert.deepEqual(result, { role: 'api', APP_ENV: 'test', HTTP_HOST: '127.0.0.1', HTTP_PORT: 3000 });
  assert.equal(Object.isFrozen(result), true);
});

await test('required and invalid configuration reports field names without values', () => {
  for (const env of [
    {}, { APP_ENV: 'test' }, { APP_ENV: 'private-marker', HTTP_PORT: 'private-marker' },
    ...['', '0', '-1', '65536', '3.5', ' 3000', '3e3'].map(HTTP_PORT => ({ APP_ENV: 'test', HTTP_PORT })),
  ]) {
    assert.throws(() => loadConfig('api', env), (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.ok(error.fields.length > 0);
      assert.ok(!error.message.includes('private-marker'));
      return true;
    });
  }
});

await test('Worker needs APP_ENV but has no dependency on HTTP settings', () => {
  assert.deepEqual(loadConfig('worker', { APP_ENV: 'test', HTTP_PORT: 'not-used' }), {
    role: 'worker', APP_ENV: 'test',
  });
  assert.throws(() => loadConfig('worker', {}), ConfigValidationError);
});
