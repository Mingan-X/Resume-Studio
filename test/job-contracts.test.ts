import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dimensionIds, dimensionWeightsSchema, jobScoringInputSchema, jobVersionSchema, requirementsSchema } from '../src/contracts/jobs.js';
import { rubricVersionSchema } from '../src/contracts/rubric.js';
import { jobIndexInputSnapshotSchema } from '../src/contracts/tasks.js';
import { jdDocument, validateJobRequirements } from '../src/modules/jobs/evidence.js';
import { SyntheticCompletionHandler } from '../src/infrastructure/consumer/task-delivery.handler.js';
import { TaskExecutionStore } from '../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../src/infrastructure/consumer/config.js';
import { jobIndexInput } from './support/task-inputs.js';
import type { ExecutionClaim } from '../src/infrastructure/consumer/contracts.js';

const weights = dimensionIds.map(dimension => ({ dimension, weight: 1 }));
function fixture() {
  const ownerId = randomUUID(), id = randomUUID(), document = jdDocument(id, '中文\r\n工程😀e\u0301');
  const block = document.blocks[0]!;
  const requirement = { stableId: 'req-1', dimension: 'engineering', kind: 'HARD', description: '工程实践',
    threshold: null, weight: 1, priority: 0, sourceRef: { sourceType: 'JD', sourceVersionId: id,
      blockId: block.id, start: 3, end: 5, quote: '工程' } };
  return { ownerId, id, document, requirement };
}
await test('JD normalized evidence reuses exact quote, owner, version and surrogate boundaries', () => {
  const f = fixture(), block = f.document.blocks[0]!;
  assert.equal(block.text, '中文\n工程😀é');
  assert.deepEqual(jdDocument(f.id, block.text), f.document);
  assert.equal(validateJobRequirements(f.ownerId, f.ownerId, f.document, [f.requirement]).length, 1);
  for (const patch of [{ sourceType: 'RESUME' }, { sourceVersionId: randomUUID() }, { blockId: randomUUID() },
    { start: 5, end: 6, quote: '\ud83d' }, { start: 0, end: 2, quote: '假造' }, { start: 100, end: 102, quote: '工程' }]) {
    assert.throws(() => validateJobRequirements(f.ownerId, f.ownerId, f.document, [{ ...f.requirement, sourceRef: { ...f.requirement.sourceRef, ...patch } }]));
  }
  assert.throws(() => validateJobRequirements(randomUUID(), f.ownerId, f.document, [f.requirement]));
  assert.throws(() => jdDocument(randomUUID(), ' \n '));
  assert.notEqual(jdDocument(randomUUID(), block.text).blocks[0]!.id, block.id);
});
await test('weights reject omissions, unsupported or duplicate IDs, nonfinite numbers and ineffective sums', () => {
  const { requirement } = fixture();
  const input = { requirements: [requirement], dimensionWeights: weights };
  assert.ok(jobScoringInputSchema.safeParse(input).success);
  for (const value of [-1, NaN, Infinity, -Infinity, undefined]) {
    assert.equal(jobScoringInputSchema.safeParse({ ...input, requirements: [{ ...requirement, weight: value }] }).success, false);
    assert.equal(dimensionWeightsSchema.safeParse(weights.map((w, i) => i ? w : { ...w, weight: value })).success, false);
  }
  for (const values of [weights.slice(1), [...weights.slice(1), weights[1]], weights.map(w => ({ ...w, weight: 0 })),
    weights.map(w => ({ ...w, dimension: 'unsupported' })), weights.map(w => ({ ...w, weight: Number.MAX_VALUE }))]) {
    assert.equal(dimensionWeightsSchema.safeParse(values).success, false);
  }
  assert.equal(requirementsSchema.safeParse([requirement, requirement]).success, false);
  assert.equal(requirementsSchema.safeParse([{ ...requirement, score: 100 }]).success, false);
  assert.equal(jobScoringInputSchema.safeParse({ ...input, requirements: [{ ...requirement, weight: 0 }] }).success, false);
  assert.equal(jobScoringInputSchema.safeParse({ ...input, dimensionWeights: weights.map(w => ({ ...w, weight: w.dimension === 'engineering' ? 0 : 1 })) }).success, false);
  assert.ok(jobScoringInputSchema.safeParse({ ...input, requirements: [requirement, { ...requirement, stableId: 'zero', weight: 0 }] }).success);
});
await test('published job versions require confirmation, matching document version and usable weights', () => {
  const f = fixture();
  const draft = { schemaVersion: 1, id: f.id, ownerId: f.ownerId, jobId: randomUUID(), version: 1,
    title: '合成岗位', city: null, level: null, skills: [], document: f.document, requirements: [f.requirement],
    dimensionWeights: weights, hardRequirementsConfirmed: false, weightsConfirmed: false, createdAt: new Date().toISOString(),
    status: 'DRAFT', contentHash: null, publishedAt: null, indexStatus: 'NOT_REQUESTED' };
  assert.ok(jobVersionSchema.safeParse(draft).success);
  const published = { ...draft, status: 'PUBLISHED', contentHash: 'a'.repeat(64), publishedAt: draft.createdAt, indexStatus: 'PENDING' };
  assert.equal(jobVersionSchema.safeParse(published).success, false);
  assert.ok(jobVersionSchema.safeParse({ ...published, hardRequirementsConfirmed: true, weightsConfirmed: true }).success);
  assert.equal(jobVersionSchema.safeParse({ ...draft, id: randomUUID() }).success, false);
});
await test('rubric requires exactly six dimensions and five complete levels with unique feature IDs', () => {
  const rubric = { schemaVersion: 1, version: 'fixture-v1', provenance: 'SYNTHETIC', reviewStatus: 'TEST_ONLY',
    dimensions: dimensionIds.map(dimension => ({ dimension, levels: [1, 2, 3, 4, 5].map(level => ({ level,
      score: level * 20, behavior: '合成行为', evidenceThreshold: '合成证据', features: [{ featureId: `${dimension}-${level}`, description: '合成特征' }] })) })) };
  assert.ok(rubricVersionSchema.safeParse(rubric).success);
  assert.equal(rubricVersionSchema.safeParse({ ...rubric, reviewStatus: 'APPROVED' }).success, false);
  assert.equal(rubricVersionSchema.safeParse({ ...rubric, dimensions: rubric.dimensions.slice(1) }).success, false);
  for (const mutate of [(r: typeof rubric) => { r.dimensions[0]!.levels.pop(); },
    (r: typeof rubric) => { r.dimensions[0]!.levels[0]!.level = 2; },
    (r: typeof rubric) => { r.dimensions[1]!.dimension = r.dimensions[0]!.dimension; },
    (r: typeof rubric) => { r.dimensions[0]!.levels[1]!.features[0]!.featureId = r.dimensions[0]!.levels[0]!.features[0]!.featureId; }]) {
    const copy = structuredClone(rubric); mutate(copy); assert.equal(rubricVersionSchema.safeParse(copy).success, false);
  }
});
await test('real index snapshots cannot be completed or persisted by synthetic handlers', async () => {
  const ownerId = randomUUID();
  const snapshot = jobIndexInputSnapshotSchema.parse({ ...jobIndexInput(), ownerId, kind: 'job-index' });
  assert.equal(jobIndexInputSnapshotSchema.safeParse({ ...snapshot, kind: 'anything' }).success, false);
  const claim: ExecutionClaim = { ownerId, consumerName: 'job-index.worker.v1',
    message: { schemaVersion: 1, taskType: 'job-index', taskId: randomUUID(), messageId: randomUUID(), dispatchGeneration: 1, occurredAt: new Date().toISOString() },
    snapshot, attemptId: randomUUID(), fenceToken: 1n, startedAt: new Date(), deadline: new Date(Date.now() + 5000) };
  assert.throws(() => new SyntheticCompletionHandler().execute(claim, new AbortController().signal), /UNSUPPORTED_INPUT/);
  const store = new TaskExecutionStore({ client: { $transaction: () => { assert.fail('No database write allowed'); } } }, consumerConfigSchema.parse({}));
  await assert.rejects(store.complete(claim, {}), /UNSUPPORTED_INPUT/);
  await assert.rejects(store.nodeArtifact(claim, 'index', {}), /UNSUPPORTED_INPUT/);
  await assert.rejects(store.publishSyntheticIndex(claim, randomUUID()), /UNSUPPORTED_INPUT/);
});
