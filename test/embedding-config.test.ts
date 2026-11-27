import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { loadEmbeddingExecutor, embeddingRuntimeConfigSchema } from '../src/infrastructure/models/embedding-config.js';

await test('S2.3 embedding runtime requires a bounded absolute local config and matching currency', async t => {
  const directory = await mkdtemp(resolve('data/s23-embedding-config-')), path = join(directory, 'config.json');
  t.after(async () => { await unlink(path); await rmdir(directory); });
  const config = { connection: { endpoint: 'https://fixture-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings',
    apiKey: 'synthetic-placeholder-key', model: 'text-embedding-v4', dimensions: 64, embeddingVersion: 'fixture-bailian-v1', currency: 'CNY' },
    execution: { singleTimeoutMs: 100, totalTimeoutMs: 1000, maxAttempts: 2, retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 1,
      inputTokenReservation: 1000, costReservationMicros: 10, maxTokens: 2000, maxCostMicros: 20, currency: 'CNY' } };
  await writeFile(path, JSON.stringify(config));
  const executor = await loadEmbeddingExecutor(path);
  assert.equal(executor.embeddingVersion, 'fixture-bailian-v1'); assert.equal(executor.dimensions, 64);
  assert.equal(executor.provenance, 'bailian'); // Constructor only; never invoke a real endpoint in this test.
  assert.equal(embeddingRuntimeConfigSchema.safeParse({ ...config, execution: { ...config.execution, currency: 'USD' } }).success, false);
  await assert.rejects(loadEmbeddingExecutor('relative.json'));
  await writeFile(path, JSON.stringify({ ...config, connection: { ...config.connection, endpoint: 'http://127.0.0.1:1/compatible-mode/v1/embeddings' } }));
  await assert.rejects(loadEmbeddingExecutor(path), /ENDPOINT_INVALID/);
  await writeFile(path, 'x'.repeat(65537)); await assert.rejects(loadEmbeddingExecutor(path), /CONFIG_LIMIT/);
});
