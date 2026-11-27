import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigValidationError, loadConfig } from '../src/modules/config/app-config.js';

await test('production business routes require explicit session mode and a precise HTTPS origin', () => {
  const env={APP_ENV:'production',HTTP_PORT:'3000',HTTP_HOST:'0.0.0.0',TASK_API_ENABLED:'true',AUTH_ENABLED:'true',
    AUTH_ORIGIN:'https://resume.example',DATABASE_URL:'postgresql://resume_studio_test:synthetic@127.0.0.1:55432/resume_studio_s12_test'};
  assert.equal(loadConfig('api',env).auth?.origin,env.AUTH_ORIGIN);
  for(const patch of [{AUTH_ENABLED:'false'},{AUTH_ENABLED:'yes'},{AUTH_ORIGIN:'http://resume.example'},
    {AUTH_ORIGIN:'https://resume.example/path'},{AUTH_ORIGIN:'https://resume.example/'},{AUTH_SESSION_SECONDS:'86401'},
    {AUTH_ANONYMOUS_SECONDS:'0'}]) assert.throws(()=>loadConfig('api',{...env,...patch}),ConfigValidationError);
});

await test('API configuration converts the port and excludes unrelated secrets', () => {
  const result = loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000', API_KEY: 'private-marker' });
  assert.deepEqual(result, { role: 'api', APP_ENV: 'test', HTTP_HOST: '127.0.0.1', HTTP_PORT: 3000 });
  assert.equal(Object.isFrozen(result), true);
});

await test('resume API requires explicit local identity, project database and absolute storage root', () => {
  const env = { APP_ENV: 'test', HTTP_PORT: '3000', RESUME_API_ENABLED: 'true', STORAGE_ROOT: process.cwd(),
    DATABASE_URL: 'postgresql://resume_studio_test:synthetic@127.0.0.1:55432/resume_studio_s12_test' };
  assert.ok(loadConfig('api', env).resumes);
  for (const change of [{ APP_ENV: 'production' }, { HTTP_HOST: '0.0.0.0' }, { STORAGE_ROOT: '../escape' },
    { RESUME_API_ENABLED: 'yes' }, { DATABASE_URL: 'postgresql://foreign:synthetic@127.0.0.1:55432/foreign' }]) {
    assert.throws(() => loadConfig('api', { ...env, ...change }), ConfigValidationError);
  }
});

await test('job API configuration accepts absent model settings but rejects public identity and relative secret files', () => {
  const env = { APP_ENV: 'test', HTTP_PORT: '3000', JOB_API_ENABLED: 'true', DATABASE_URL: 'postgresql://resume_studio_test:synthetic@127.0.0.1:55432/resume_studio_s12_test' };
  assert.ok(loadConfig('api', env).jobs);
  for (const patch of [{ APP_ENV: 'production' }, { HTTP_HOST: '0.0.0.0' }, { JOB_API_ENABLED: 'yes' }, { JOB_MODEL_CONFIG_FILE: 'relative.json' }]) {
    assert.throws(() => loadConfig('api', { ...env, ...patch }), ConfigValidationError);
  }
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

await test('task API is explicit, uses the project database and refuses production or public development identity', () => {
  const valid = { APP_ENV: 'test', HTTP_PORT: '3000', TASK_API_ENABLED: 'true',
    DATABASE_URL: 'postgresql://resume_studio_test:synthetic-only@127.0.0.1:55432/resume_studio_s12_test' };
  assert.equal(loadConfig('api', valid).tasks?.databaseUrl, valid.DATABASE_URL);
  assert.equal(loadConfig('api', { ...valid, TASK_API_ENABLED: 'false' }).tasks, undefined);
  for (const extra of [{ TASK_API_ENABLED: '1' }, { APP_ENV: 'production' }, { HTTP_HOST: '0.0.0.0' },
    { DATABASE_URL: '' }, { DATABASE_URL: valid.DATABASE_URL.replace('127.0.0.1', 'foreign.invalid') },
    { DATABASE_URL: valid.DATABASE_URL.replace('55432','5432') }, { DATABASE_URL: valid.DATABASE_URL.replace('resume_studio_test:','postgres:') }]) {
    assert.throws(() => loadConfig('api', { ...valid, ...extra }), (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError); assert.ok(!error.message.includes('synthetic-only')); return true;
    });
  }
});
