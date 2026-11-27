import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateEvaluationDataset } from '../src/modules/evaluation/dataset.js';
import { evaluateQuality } from '../src/modules/evaluation/quality.js';
import { requestHash } from '../src/modules/tasks/request-hash.js';

// Fabricated labels test arithmetic only. Never write these objects as quality evidence.
function fixture() {
  const dataset = generateEvaluationDataset(), job = dataset.jobs[0]!, datasetHash = requestHash(dataset);
  const run = { schemaVersion: 1, runVersion: 'unit-only', provenance: 'REAL_MODEL_AND_EMBEDDING', datasetHash,
    performedAt: '2026-11-28T00:00:00Z', modelVersion: 'unit-only', promptVersion: 'unit-only', embeddingVersion: 'unit-only',
    rubricVersion: 'unit-only', scoringPolicyVersion: 'unit-only', currency: 'CNY', results: dataset.resumes.map((resume, index) => ({
      resumeId: resume.id, resumeHash: resume.contentHash, durationMs: 10, inputTokens: 1, outputTokens: 2, costMicros: index ? 100 : null,
      degraded: false, output: { candidateJobVersionIds: [job.id], structured: [{ id: 'skills', value: [] }],
        citations: [{ id: 'valid', start: 0, end: 2, quote: resume.text.slice(0, 2) }, { id: 'invalid', start: 0, end: 2, quote: 'XX' }],
        requirements: job.requirements.map((requirement, ordinal) => ({ jobVersionId: job.id, requirementId: requirement.stableId,
          verdict: ordinal === 0 ? 'met' : ordinal === 1 ? 'unknown' : null, citationIds: ordinal === 0 ? ['valid'] : [] })),
        rankedJobVersionIds: [job.id],
      },
    })) };
  const annotations = { schemaVersion: 1, annotationVersion: 'unit-only', provenance: 'HUMAN_ANNOTATED', datasetHash,
    reviewedBy: 'unit-only-not-a-human-review', reviewedAt: '2026-11-28T00:00:00Z', results: run.results.map(result => ({
      resumeId: result.resumeId, outputHash: requestHash(result.output), expectedFieldIds: ['skills', 'education'],
      fields: [{ id: 'skills', correct: true }], citations: [{ id: 'valid', supported: true }, { id: 'invalid', supported: true }],
      requirements: result.output.requirements.filter(item => item.verdict !== null).map(item => ({
        jobVersionId: item.jobVersionId, requirementId: item.requirementId, expected: item.verdict === 'met' ? 'partial' : 'unknown',
      })), relevance: dataset.jobs.map(item => ({ jobVersionId: item.id, relevant: item.id === job.id })),
    })) };
  return { dataset, run, annotations };
}

await test('S3.3 quality distinguishes invalid citations, omitted fields, unexecuted requirements and unknown cost', () => {
  const { dataset, run, annotations } = fixture(), result = evaluateQuality(dataset, run, annotations, 20);
  assert.equal(result.citationLocationValidity.rate, 0.5); assert.equal(result.citationSupportedValidity.rate, 0.5);
  assert.equal(result.structuredCorrectness.rate, 1); assert.equal(result.structuredCoverage.rate, 0.5);
  assert.equal(result.requirementAccuracy.rate, 0.5); assert.equal(result.unexecutedRequirements, 80);
  assert.equal(result.unknownPrecision.rate, 1); assert.equal(result.unknownRecall.rate, 1);
  assert.equal(result.confusionMatrix.partial!.met, 20); assert.equal(result.recall.macro, 1);
  assert.equal(result.usage.totalCostMicros, null); assert.equal(result.usage.knownCostMicros, 1900);
  assert.equal(result.usage.costUnknownSamples, 1); assert.equal(result.usage.totalTokens, 60);
  assert.equal(result.releaseThreshold, null);
});

await test('S3.3 quality refuses missing labels, omitted planned requirements and changed hashes or provenance', () => {
  const { dataset, run, annotations } = fixture();
  const check = (a: unknown, r: unknown = run) => assert.throws(() => evaluateQuality(dataset, r, a, 20));
  check({ ...annotations, results: annotations.results.slice(1) });
  check({ ...annotations, provenance: 'AI_GENERATED' });
  check(annotations, { ...run, provenance: 'SYNTHETIC' });
  check(annotations, { ...run, datasetHash: 'a'.repeat(64) });
  for (const field of ['fields', 'citations', 'requirements', 'relevance'] as const) {
    const changed = structuredClone(annotations); changed.results[0]![field].pop(); check(changed);
  }
  const changedRun = structuredClone(run), changedAnnotations = structuredClone(annotations);
  changedRun.results[0]!.output.requirements.pop();
  changedAnnotations.results[0]!.outputHash = requestHash(changedRun.results[0]!.output);
  check(changedAnnotations, changedRun);
  const duplicate = structuredClone(annotations); duplicate.results[0]!.relevance[1] = duplicate.results[0]!.relevance[0]!; check(duplicate);
});

await test('S3.3 no relevant jobs or no citations yields null, and unknown false positives remain visible', () => {
  const { dataset, run, annotations } = fixture();
  for (const result of run.results) {
    result.output.citations = [];
    for (const item of result.output.requirements) item.citationIds = [];
    const annotation = annotations.results.find(item => item.resumeId === result.resumeId)!;
    annotation.outputHash = requestHash(result.output); annotation.citations = [];
    for (const item of annotation.relevance) item.relevant = false;
    for (const item of annotation.requirements) item.expected = 'partial';
  }
  const result = evaluateQuality(dataset, run, annotations, 20);
  assert.equal(result.citationLocationValidity.rate, null); assert.equal(result.recall.macro, null);
  assert.equal(result.recall.excludedNoRelevant, 20); assert.equal(result.unknownPrecision.rate, 0); assert.equal(result.unknownRecall.rate, null);
});
