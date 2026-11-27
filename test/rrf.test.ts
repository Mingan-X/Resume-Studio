import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fuseRecall } from '../src/modules/recall/rrf.js';
import { recallConfigSchema, recallResultSchema } from '../src/contracts/recall.js';

await test('S2.3 RRF deduplicates rank sources, caps 20 and uses stable IDs for equal scores', () => {
  const config = recallConfigSchema.parse({ version: 'hybrid-rrf-v1', vectorFailure: 'keyword' });
  const rows = Array.from({ length: 60 }, (_, index) => ({ jobId: randomUUID(), jobVersionId: randomUUID(), rank: index + 1 }));
  const vector = [rows[1]!, rows[0]!].map((row, index) => ({ ...row, rank: index + 1 }));
  const result = fuseRecall(rows, vector, config);
  assert.equal(result.length, 20); assert.equal(new Set(result.map(row => row.jobVersionId)).size, 20);
  assert.equal(result[0]!.rrfScore, 1 / 61 + 1 / 62);
  assert.ok(result[0]!.jobId < result[1]!.jobId);
  assert.equal(result[0]!.sources.length, 2); assert.equal(result[2]!.sources[0]!.source, 'keyword');
  for (let attempt = 0; attempt < 100; attempt++) assert.deepEqual(fuseRecall(rows, vector, config), result);
  assert.deepEqual(fuseRecall([], [], config), []);
  assert.throws(() => fuseRecall([rows[0], { ...rows[0], rank: 2 }], [], config), /RANKS/);
  assert.throws(() => fuseRecall([rows[1]], [], config), /RANKS/);
  assert.throws(() => fuseRecall([rows[0]], [{ ...rows[0], jobId: randomUUID() }], config), /IDENTITY/);
  assert.throws(() => fuseRecall([], [], { ...config, limit: 21 }));
  const valid = { schemaVersion: 1, corpusVersion: 'corpus-v1', corpusHash: 'a'.repeat(64), config,
    embeddingVersion: 'fixture-v1', indexSpec: { schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId: randomUUID(),
      embeddingVersion: 'fixture-v1', indexVersion: 'index-v1', dimensions: 8, provenance: 'synthetic', chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1' },
    candidates: result, degraded: false, degradationReason: null };
  assert.equal(recallResultSchema.safeParse(valid).success, true);
  assert.equal(recallResultSchema.safeParse({ ...valid, degraded: true, degradationReason: 'VECTOR_UNAVAILABLE' }).success, false);
});
