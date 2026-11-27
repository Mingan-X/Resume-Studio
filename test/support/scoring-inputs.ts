import { scoringPolicySchema } from '../../src/contracts/scoring.js';
import { dimensionIds } from '../../src/contracts/jobs.js';

// Contract fixture only; production default is published separately.
export function scoringPolicy(version = 'test-scoring-v1') {
  return scoringPolicySchema.parse({ schemaVersion: 1, version, dimensionWeights: dimensionIds.map(dimension => ({ dimension, weight: 1 })),
    requirementWeightPolicy: 'frozen-job-relative', verdictCoefficients: { met: 10000, partial: 5000, unmet: 0, unknown: 0 },
    dimensionWeightPolicy: 'scoring-policy-or-explicit-recompute', partialHardPolicy: 'pending', incompleteEligibilityPolicy: 'pending-unless-hard-unmet',
    unknownPolicy: 'zero-with-separate-coverage-and-upper-bound', incompletePolicy: 'zero-with-separate-execution-state-and-upper-bound',
    hardGatePolicy: 'unmet-ineligible-unverified-pending-all-met-eligible',
    rounding: { mode: 'half-up', displayDecimals: 2, sortDecimals: 6, arithmetic: 'decimal-rational' } });
}
