import { scoringPolicySchema } from '../../contracts/scoring.js';
import { dimensionIds } from '../../contracts/jobs.js';

// D7, including the maintainer's explicit S2.5 clarification. Import under an explicit owner before use.
export const defaultScoringPolicy = scoringPolicySchema.parse({ schemaVersion: 1, version: 'scoring-v1',
  dimensionWeights: dimensionIds.map(dimension => ({ dimension, weight: 1 })),
  dimensionWeightPolicy: 'scoring-policy-or-explicit-recompute', requirementWeightPolicy: 'frozen-job-relative',
  verdictCoefficients: { met: 10000, partial: 5000, unmet: 0, unknown: 0 },
  unknownPolicy: 'zero-with-separate-coverage-and-upper-bound', incompletePolicy: 'zero-with-separate-execution-state-and-upper-bound',
  hardGatePolicy: 'unmet-ineligible-unverified-pending-all-met-eligible', partialHardPolicy: 'pending', incompleteEligibilityPolicy: 'pending-unless-hard-unmet',
  rounding: { mode: 'half-up', displayDecimals: 2, sortDecimals: 6, arithmetic: 'decimal-rational' },
});
