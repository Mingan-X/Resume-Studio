import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
await test('S2.3 real index CLI fails closed before services for missing config and production fixed identity', async () => {
  for (const environment of ['development', 'production']) {
    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: environment };
    delete env.JOB_EMBEDDING_CONFIG_FILE;
    await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('../src/infrastructure/jobs/index-worker.cli.js', import.meta.url)), 'consume'],
      { env, timeout: 10_000 }), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'stderr' in error && 'stdout' in error);
        assert.equal(String(error.stderr).trim(), '{"code":"INDEX_RUNTIME_FAILED"}');
        assert.equal(String(error.stdout).trim(), ''); return true;
      });
  }
});
