import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCheckpointConfig, loadCheckpointSetupUrl } from '../src/infrastructure/checkpoint/config.js';
import { ConfigValidationError } from '../src/modules/config/app-config.js';

const password = 'a'.repeat(48);
const runtime = `postgresql://resume_studio_checkpoint:${password}@127.0.0.1:55432/resume_studio_checkpoint`;
const env = { CHECKPOINT_DATABASE_URL: runtime, CHECKPOINT_SCHEMA: 'langgraph', CHECKPOINT_POOL_MAX: '3' };

await test('Checkpoint configuration separates runtime credentials and limits the pool', () => {
  assert.deepEqual(loadCheckpointConfig({ ...env, CHECKPOINT_SETUP_URL: 'secret' }), {
    databaseUrl: runtime, schema: 'langgraph', poolMax: 3,
  });
  for (const value of ['0', '4', '-1', '1.5', '']) {
    assert.throws(() => loadCheckpointConfig({ ...env, CHECKPOINT_POOL_MAX: value }), ConfigValidationError);
  }
});

await test('Checkpoint configuration rejects other databases, roles, endpoints and schema injection without leaking secrets', () => {
  for (const value of [
    runtime.replace('127.0.0.1', 'example.com'), runtime.replace('55432', '5432'),
    runtime.replace('/resume_studio_checkpoint', '/resume_studio_s12_test'),
    runtime.replace('resume_studio_checkpoint:', 'resume_studio_checkpoint_setup:'),
    `${runtime}?options=private-marker`, `${runtime}#private-marker`, 'private-marker',
  ]) {
    assert.throws(() => loadCheckpointConfig({ ...env, CHECKPOINT_DATABASE_URL: value }), (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.ok(!error.message.includes(password) && !error.message.includes('private-marker'));
      return true;
    });
  }
  assert.throws(() => loadCheckpointConfig({ ...env, CHECKPOINT_SCHEMA: 'public;drop schema public' }), ConfigValidationError);
  assert.throws(() => loadCheckpointSetupUrl({ CHECKPOINT_SETUP_URL: runtime }), ConfigValidationError);
});
