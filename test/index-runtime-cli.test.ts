import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const execute = promisify(execFile);
await test('S2.3 real index CLI fails closed before services for missing config and production fixed identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-index-import-'));
  t.after(() => rm(directory, { recursive: true }));
  for (const environment of ['development', 'production']) {
    const report = join(directory, `${environment}.json`);
    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: environment, MODULE_LOAD_REPORT: report };
    delete env.JOB_EMBEDDING_CONFIG_FILE;
    await assert.rejects(execute(process.execPath, ['--import', new URL('./fixtures/module-load.fixture.js', import.meta.url).href,
      fileURLToPath(new URL('../src/infrastructure/jobs/index-worker.cli.js', import.meta.url)), 'consume'],
      { env, timeout: 10_000 }), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'stderr' in error && 'stdout' in error);
        assert.equal(String(error.stderr).trim(), '{"code":"INDEX_RUNTIME_FAILED"}');
        assert.equal(String(error.stdout).trim(), ''); return true;
      });
    const loaded = z.array(z.string()).parse(JSON.parse(await readFile(report, 'utf8')) as unknown)
      .map(url => decodeURIComponent(url).replaceAll('\\', '/'));
    assert.ok(!loaded.some(url => url.includes('/@nestjs/') || url.includes('/generated/prisma/') || url.endsWith('/index-worker-runtime.js')));
  }
});
