import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requirementExecutionSchema } from '../src/contracts/matching.js';
import { calculateScore } from '../src/modules/scoring/score.js';
import { jobDraft } from './support/job-inputs.js';
import { scoringPolicy } from './support/scoring-inputs.js';

function fixture(verdicts: ('met'|'partial'|'unmet'|'unknown'|'BUDGET')[] = ['met','partial','unknown']) {
  const draft = jobDraft(randomUUID()), template = draft.requirements[0]!, policy = scoringPolicy();
  const requirements = verdicts.map((_verdict, index) => ({ ...template, stableId: `r${index}`, weight: index === 0 ? 2 : 1 }));
  const executions = verdicts.map((verdict, ordinal) => requirementExecutionSchema.parse({ jobVersionId: draft.id, requirementId: `r${ordinal}`, ordinal,
    status: verdict === 'BUDGET' ? 'BUDGET' : 'DONE', errorCode: verdict === 'BUDGET' ? 'BUDGET_EXHAUSTED' : null,
    judgment: verdict === 'BUDGET' ? null : { jobVersionId: draft.id, requirementId: `r${ordinal}`, verdict, method: 'model', reason: '合成判断',
      evidenceRefs: verdict === 'unknown' ? [] : [{ ...template.sourceRef, sourceType: 'RESUME' }] } }));
  return { policy, input: { jobVersionId: draft.id, requirements, executions, weights: { dimensionWeights: policy.dimensionWeights,
    requirementWeights: requirements.map(item => ({ requirementId: item.stableId, weight: item.weight })) } } };
}
await test('S2.5 architecture example is exactly 62.5/75/87.5 and reproduces across 100 evaluations and permutations', () => {
  const { policy, input } = fixture(), expected = calculateScore(input, policy);
  assert.equal(expected.total, 62.5); assert.equal(expected.coverage, 75); assert.equal(expected.upperBound, 87.5);
  assert.equal(expected.unknown, 1); assert.equal(expected.contributions[2]?.execution.status, 'DONE');
  assert.deepEqual(expected.contributions[0]?.normalizedWeight, { numerator: '1', denominator: '2' });
  for (let index = 0; index < 100; index++) assert.deepEqual(calculateScore(index % 2 ? { ...input, requirements: [...input.requirements].reverse(),
    executions: [...input.executions].reverse(), weights: { dimensionWeights: [...input.weights.dimensionWeights].reverse(), requirementWeights: [...input.weights.requirementWeights].reverse() } } : input, policy), expected);
});
await test('S2.5 normalizes within dimensions, excludes zero dimensions without zero division and rejects missing/invalid inputs', () => {
  const { policy, input } = fixture(['met','unmet']); input.requirements[1]!.dimension = 'growth';
  const equal = calculateScore(input, policy); assert.equal(equal.total, 50);
  const zero = { ...input, weights: { ...input.weights, dimensionWeights: input.weights.dimensionWeights.map(item => ({ ...item, weight: item.dimension === 'growth' ? 0 : 1 })),
    requirementWeights: [{ requirementId: 'r0', weight: 1 }, { requirementId: 'r1', weight: 0 }] } };
  assert.equal(calculateScore(zero, policy).total, 100);
  assert.throws(() => calculateScore({ ...input, weights: { ...input.weights, requirementWeights: [{ requirementId: 'r0', weight: 0 }, { requirementId: 'r1', weight: 1 }] } }, policy), /WEIGHT_ZERO/);
  for (const bad of [{ ...input, executions: input.executions.slice(1) }, { ...input, executions: [input.executions[0], input.executions[0]] },
    { ...input, requirements: [input.requirements[0], input.requirements[0]] },
    { ...input, weights: { ...input.weights, requirementWeights: [{ requirementId: 'missing', weight: 1 }, { requirementId: 'r1', weight: 1 }] } }]) assert.throws(() => calculateScore(bad, policy));
  for (const weight of [-1, NaN, Infinity]) assert.throws(() => calculateScore({ ...input, weights: { ...input.weights,
    requirementWeights: input.weights.requirementWeights.map(item => ({ ...item, weight })) } }, policy));
  const empty = fixture([]); assert.equal(calculateScore(empty.input, empty.policy).total, null); assert.equal(calculateScore(empty.input, empty.policy).eligibility, 'ineligible');
});
await test('S2.5 hard gates use every requirement even with zero weight; partial/unknown/incomplete are pending', () => {
  for (const [verdict, eligible] of [['met','eligible'],['partial','pending'],['unknown','pending'],['unmet','ineligible'],['BUDGET','pending']] as const) {
    const { policy, input } = fixture(['met',verdict]); input.requirements[1]!.kind = 'HARD'; input.weights.requirementWeights[1]!.weight = 0;
    assert.equal(calculateScore(input, policy).eligibility, eligible);
  }
  const incomplete = fixture(['met','BUDGET']), result = calculateScore(incomplete.input, incomplete.policy);
  assert.equal(result.eligibility, 'pending'); assert.equal(result.incomplete, 1); assert.equal(result.unknown, 0);
  assert.equal(result.total, 66.67); assert.equal(result.coverage, 66.67); assert.equal(result.upperBound, 100);
  const rejected = fixture(['unmet','BUDGET']); rejected.input.requirements[0]!.kind = 'HARD'; assert.equal(calculateScore(rejected.input, rejected.policy).eligibility, 'ineligible');
});
await test('S2.5 weighted outcomes stay bounded and all-met/unknown endpoints hold for fractional weights', () => {
  for (let index = 1; index <= 100; index++) {
    const { policy, input } = fixture(['met','partial','unknown']);
    input.weights.requirementWeights = [{ requirementId: 'r0', weight: index / 100 }, { requirementId: 'r1', weight: (101-index) / 10 }, { requirementId: 'r2', weight: 1e-7 }];
    const result = calculateScore(input, policy); assert.ok(result.total! >= 0 && result.total! <= result.upperBound! && result.upperBound! <= 100);
    assert.ok(result.coverage! >= 0 && result.coverage! <= 100);
  }
  const all = fixture(['met','met','met']); assert.equal(calculateScore(all.input, all.policy).total, 100);
  const unknown = fixture(['unknown','unknown']); const result = calculateScore(unknown.input, unknown.policy);
  assert.equal(result.total, 0); assert.equal(result.coverage, 0); assert.equal(result.upperBound, 100);
});
