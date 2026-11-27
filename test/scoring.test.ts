import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requirementExecutionSchema } from '../src/contracts/matching.js';
import { calculateScoreMetrics as calculateScore } from '../src/modules/scoring/score.js';
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
