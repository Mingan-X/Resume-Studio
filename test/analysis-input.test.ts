import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisConfigurationSchema, analysisInputSnapshotSchema, realAnalysisInputSchema } from '../src/contracts/tasks.js';
import { createAnalysisRequestSchema } from '../src/contracts/analyses.js';
import { analysisConfiguration } from './support/analysis-inputs.js';
import { analysisInput } from './support/task-inputs.js';
import { loadConfig } from '../src/modules/config/app-config.js';
import { loadAnalysisConfiguration } from '../src/infrastructure/tasks/analysis-config.js';

await test('real analysis freezes named corpus and strict safe config without weakening synthetic snapshots', () => {
  const request = { resumeVersionId: randomUUID(), asOfDate: '2026-11-27', jobCorpusVersionId: 'corpus-v1' };
  assert.deepEqual(createAnalysisRequestSchema.parse(request), request);
  assert.equal(createAnalysisRequestSchema.safeParse({ ...request, ownerId: randomUUID() }).success, false);
  assert.equal(createAnalysisRequestSchema.safeParse({ ...request, budget: {} }).success, false);
  const snapshot = { ...analysisConfiguration(), ...request, ownerId: randomUUID(), kind: 'analysis',
    configurationHash: 'a'.repeat(64), corpusHash: 'b'.repeat(64), rubricHash: 'c'.repeat(64), resumeFileHash: 'd'.repeat(64) };
  assert.equal(realAnalysisInputSchema.parse(snapshot).maxJudgments, 400);
  assert.equal(analysisInputSnapshotSchema.parse(snapshot).kind, 'analysis');
  assert.equal(analysisInputSnapshotSchema.parse({ ...analysisInput(), ownerId: randomUUID() }).kind, 'synthetic');
  for (const input of [{ ...snapshot, embeddingVersion: 'mismatch' }, { ...snapshot, apiKey: 'must-not-persist' }, { ...snapshot, maxJudgments: 401 }]) {
    assert.equal(analysisInputSnapshotSchema.safeParse(input).success, false);
  }
  assert.equal(analysisConfigurationSchema.safeParse({ ...analysisConfiguration(), baseURL: 'https://invalid.example' }).success, false);
});
await test('analysis local configuration is optional, bounded to an absolute file, and requires local task API', async () => {
  assert.equal(await loadAnalysisConfiguration(undefined), null);
  await assert.rejects(loadAnalysisConfiguration('relative.json'), /ANALYSIS_CONFIG_FILE/);
  assert.throws(() => loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000', ANALYSIS_CONFIG_FILE: 'E:/missing.json' }), /ANALYSIS_CONFIG_FILE/);
});
await test('analysis config file loads safe versions and refuses credentials, synthetic targets and oversized files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-analysis-config-')), path = join(directory, 'configuration.json');
  t.after(() => rm(directory, { recursive: true }));
  const value = analysisConfiguration();
  await writeFile(path, JSON.stringify(value)); assert.deepEqual(await loadAnalysisConfiguration(path), value);
  for (const invalid of [{ ...value, apiKey: 'test-only-forbidden-value' },
    { ...value, indexTarget: { ...value.indexTarget, provenance: 'synthetic' } }]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(loadAnalysisConfiguration(path), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'Invalid configuration fields: ANALYSIS_CONFIG_FILE'); return true;
    });
  }
  await writeFile(path, ' '.repeat(65_537)); await assert.rejects(loadAnalysisConfiguration(path), /ANALYSIS_CONFIG_FILE/);
});
