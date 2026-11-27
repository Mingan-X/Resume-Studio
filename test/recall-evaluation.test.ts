import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { evaluateRecall } from '../src/modules/recall/evaluation.js';

// Fabricated input here tests arithmetic/validation only; it is never published as an evaluation artifact.
await test('S2.3 Recall@K validates complete annotations and real-run metadata, handles no positives honestly', () => {
  const a = randomUUID(), b = randomUUID(), c = randomUUID(), corpusHash = 'a'.repeat(64), queryHash = 'b'.repeat(64);
  const annotations = { schemaVersion: 1, annotationVersion: 'fixture-annotations', provenance: 'HUMAN_ANNOTATED', reviewedBy: 'fixture-only',
    reviewedAt: '2026-11-27T00:00:00Z', corpusHash, corpusJobVersionIds: [a, b, c], queries: [
      { queryId: 'query-1', queryHash, judgments: [{ jobVersionId: a, relevant: true }, { jobVersionId: b, relevant: true }, { jobVersionId: c, relevant: false }] },
      { queryId: 'query-2', queryHash, judgments: [a, b, c].map(jobVersionId => ({ jobVersionId, relevant: false })) },
    ] };
  const run = { schemaVersion: 1, runVersion: 'fixture-run', provenance: 'BAILIAN_REAL', embeddingVersion: 'fixture-embedding', corpusHash,
    performedAt: '2026-11-27T00:00:00Z', queries: [{ queryId: 'query-1', queryHash, degraded: false, rankedJobVersionIds: [c, a, b] },
      { queryId: 'query-2', queryHash, degraded: false, rankedJobVersionIds: [] }] };
  const result = evaluateRecall(annotations, run, 2);
  assert.equal(result.macroRecall, 0.5); assert.equal(result.microRecall, 0.5); assert.equal(result.excludedNoRelevant, 1);
  assert.equal(result.queries[1]!.recall, null);
  assert.equal(evaluateRecall(annotations, run, 3).microRecall, 1);
  assert.throws(() => evaluateRecall({ ...annotations, queries: [] }, run, 2));
  assert.throws(() => evaluateRecall({ ...annotations, provenance: 'AI_GENERATED' }, run, 2));
  assert.throws(() => evaluateRecall(annotations, { ...run, provenance: 'SYNTHETIC' }, 2));
  assert.throws(() => evaluateRecall(annotations, { ...run, corpusHash: 'c'.repeat(64) }, 2), /MISMATCH/);
  assert.throws(() => evaluateRecall(annotations, { ...run, queries: [{ ...run.queries[0], rankedJobVersionIds: [a, a] }, run.queries[1]] }, 2));
  assert.throws(() => evaluateRecall(annotations, { ...run, queries: [{ ...run.queries[0], degraded: true }, run.queries[1]] }, 2));
  assert.throws(() => evaluateRecall(annotations, { ...run, queries: [{ ...run.queries[0], rankedJobVersionIds: [randomUUID()] }, run.queries[1]] }, 2), /MISMATCH/);
  assert.throws(() => evaluateRecall({ ...annotations, queries: [{ ...annotations.queries[0], judgments: annotations.queries[0]!.judgments.slice(1) }, annotations.queries[1]] }, run, 2));
});
