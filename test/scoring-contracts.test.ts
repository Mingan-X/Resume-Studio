import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoringPolicySchema, scoreWeightsSchema } from '../src/contracts/scoring.js';
import { decimal, divide, multiply, add, display, scaledHalfUp, serialize } from '../src/modules/scoring/rational.js';
import { scoringPolicy } from './support/scoring-inputs.js';
import { defaultScoringPolicy } from '../src/modules/scoring/default-policy.js';

await test('scoring policy and weights reject missing/nonfinite/negative/duplicate/unsupported and zero-total inputs', () => {
  const policy = scoringPolicy(); assert.equal(scoringPolicySchema.parse(policy).version, 'test-scoring-v1');
  for (const weights of [[], policy.dimensionWeights.slice(1), policy.dimensionWeights.map(item => ({ ...item, weight: 0 })),
    [...policy.dimensionWeights.slice(1), policy.dimensionWeights[1]], policy.dimensionWeights.map(item => ({ ...item, dimension: 'unsupported' }))]) {
    assert.equal(scoringPolicySchema.safeParse({ ...policy, dimensionWeights: weights }).success, false);
  }
  for (const weight of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(scoringPolicySchema.safeParse({ ...policy, dimensionWeights: policy.dimensionWeights.map(item => ({ ...item, weight })) }).success, false);
    assert.equal(scoreWeightsSchema.safeParse({ dimensionWeights: policy.dimensionWeights, requirementWeights: [{ requirementId: 'r', weight }] }).success, false);
  }
  assert.equal(scoreWeightsSchema.safeParse({ dimensionWeights: policy.dimensionWeights, requirementWeights: [{ requirementId: 'r', weight: 1 }, { requirementId: 'r', weight: 2 }] }).success, false);
  assert.equal(scoringPolicySchema.safeParse({ ...policy, verdictCoefficients: { ...policy.verdictCoefficients, partial: 10001 } }).success, false);
  assert.equal(scoringPolicySchema.safeParse({ ...policy, rounding: { ...policy.rounding, mode: 'locale' } }).success, false);
});
await test('exact decimal rational arithmetic preserves fractional weights, exponent values and final half-up rounding', () => {
  assert.deepEqual(serialize(add(decimal(0.1), decimal(0.2))), { numerator: '3', denominator: '10' });
  assert.deepEqual(serialize(multiply(decimal(1e-7), decimal(1e7))), { numerator: '1', denominator: '1' });
  assert.equal(display(decimal(62.505)), 62.51);
  assert.equal(scaledHalfUp(decimal(62.5000005), 6), 62500001);
  assert.deepEqual(serialize(divide(decimal(1e308), decimal(1e308))), { numerator: '1', denominator: '1' });
  assert.throws(() => divide(decimal(1), decimal(0)), /ZERO_DENOMINATOR/);
});
await test('D7 scoring-v1 contains the confirmed equal weights, coefficients, pending rules and immutable version', () => {
  assert.deepEqual(defaultScoringPolicy, scoringPolicy('scoring-v1'));
  assert.equal(defaultScoringPolicy.dimensionWeights.every(item => item.weight === 1), true);
  assert.deepEqual(defaultScoringPolicy.verdictCoefficients, { met: 10000, partial: 5000, unmet: 0, unknown: 0 });
  assert.equal(defaultScoringPolicy.partialHardPolicy, 'pending');
  assert.equal(defaultScoringPolicy.incompleteEligibilityPolicy, 'pending-unless-hard-unmet');
});
