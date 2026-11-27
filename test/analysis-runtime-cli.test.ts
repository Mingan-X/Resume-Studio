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
await test('analysis CLI rejects missing config in development and production before loading Nest, Prisma, model adapters or runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-analysis-import-'));
  t.after(() => rm(directory, { recursive: true }));
  for (const environment of ['development', 'production']) {
    const report = join(directory, `${environment}.json`);
    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: environment, MODULE_LOAD_REPORT: report };
    delete env.ANALYSIS_MODEL_CONFIG_FILE; delete env.JOB_EMBEDDING_CONFIG_FILE;
    await assert.rejects(execute(process.execPath, ['--import', new URL('./fixtures/module-load.fixture.js', import.meta.url).href,
      fileURLToPath(new URL('../src/infrastructure/tasks/analysis-worker.cli.js', import.meta.url)), 'consume'], { env, timeout: 10000 }), error => {
      const output = z.object({ stderr: z.string(), stdout: z.string() }).parse(error);
      assert.equal(output.stderr.trim(), '{"code":"ANALYSIS_RUNTIME_FAILED"}'); assert.equal(output.stdout.trim(), ''); return true;
    });
    const loaded = z.array(z.string()).parse(JSON.parse(await readFile(report, 'utf8')) as unknown).map(url => decodeURIComponent(url).replaceAll('\\', '/'));
    assert.ok(!loaded.some(url => url.includes('/@nestjs/') || url.includes('/generated/prisma/') || url.endsWith('/analysis-worker-runtime.js') || url.endsWith('/openai-model.js')));
  }
});
