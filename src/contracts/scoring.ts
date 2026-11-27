import { z } from 'zod';
import { dimensionSchema, dimensionWeightsSchema, stableIdSchema, versionNameSchema } from './jobs.js';
import { sha256Schema } from './evidence.js';
import { requirementExecutionSchema } from './matching.js';

export const scoringPolicySchema = z.object({ schemaVersion: z.literal(1), version: versionNameSchema,
  dimensionWeights: dimensionWeightsSchema,
  dimensionWeightPolicy: z.literal('scoring-policy-or-explicit-recompute'),
  requirementWeightPolicy: z.literal('frozen-job-relative'),
  verdictCoefficients: z.object({ met: z.literal(10000), partial: z.int().min(0).max(10000), unmet: z.literal(0), unknown: z.literal(0) }).strict(),
  unknownPolicy: z.literal('zero-with-separate-coverage-and-upper-bound'),
  incompletePolicy: z.literal('zero-with-separate-execution-state-and-upper-bound'),
  hardGatePolicy: z.literal('unmet-ineligible-unverified-pending-all-met-eligible'),
  partialHardPolicy: z.literal('pending'), incompleteEligibilityPolicy: z.literal('pending-unless-hard-unmet'),
  rounding: z.object({ mode: z.literal('half-up'), displayDecimals: z.literal(2), sortDecimals: z.literal(6), arithmetic: z.literal('decimal-rational') }).strict(),
}).strict();
export type ScoringPolicy = z.infer<typeof scoringPolicySchema>;
export const scoreWeightsSchema = z.object({ dimensionWeights: dimensionWeightsSchema,
  requirementWeights: z.array(z.object({ requirementId: stableIdSchema, weight: z.number().nonnegative() }).strict()).max(400),
}).strict().refine(value => new Set(value.requirementWeights.map(item => item.requirementId)).size === value.requirementWeights.length, '要求权重ID重复');
export type ScoreWeights = z.infer<typeof scoreWeightsSchema>;
export const exactFractionSchema = z.object({ numerator: z.string().regex(/^(0|[1-9][0-9]*)$/).max(10000),
  denominator: z.string().regex(/^[1-9][0-9]*$/).max(10000) }).strict();
const percentage = z.number().min(0).max(100);
export const scoreMetricsSchema = z.object({ schemaVersion: z.literal(1), jobVersionId: z.uuid(), policyVersion: versionNameSchema,
  policyHash: sha256Schema, judgmentSetHash: sha256Schema, weightsSnapshot: scoreWeightsSchema,
  total: percentage.nullable(), coverage: percentage.nullable(), upperBound: percentage.nullable(),
  sortValue: z.int().min(0).max(100_000_000).nullable(),
  planned: z.int().nonnegative(), completed: z.int().nonnegative(), incomplete: z.int().nonnegative(), unknown: z.int().nonnegative(),
  contributions: z.array(z.object({ requirementId: stableIdSchema, dimension: dimensionSchema, kind: z.enum(['HARD','SOFT']),
    execution: requirementExecutionSchema, normalizedWeight: exactFractionSchema, exactContribution: exactFractionSchema,
    contribution: percentage,
  }).strict()).max(400),
}).strict().refine(value => value.completed + value.incomplete === value.planned && value.unknown <= value.completed
  && value.contributions.length === value.planned);
export const scoreResultSchema = scoreMetricsSchema.safeExtend({ eligibility: z.enum(['eligible','pending','ineligible']),
  eligibilityReasons: z.array(z.enum(['NO_EFFECTIVE_REQUIREMENTS','HARD_UNMET','HARD_UNVERIFIED','INCOMPLETE_JUDGMENTS'])),
});
export type ScoreResult = z.infer<typeof scoreResultSchema>;
export const rankingResultSchema = z.object({ schemaVersion: z.literal(1), results: z.array(scoreResultSchema).max(20),
  top10: z.array(z.uuid()).max(10), pending: z.array(z.uuid()).max(20), ineligible: z.array(z.uuid()).max(20),
  shortfall: z.object({ missing: z.int().min(0).max(10), reasons: z.array(z.enum(['CANDIDATE_COUNT_BELOW_TEN','INELIGIBLE_CANDIDATES','PENDING_CANDIDATES'])) }).strict(),
}).strict();
export const scoreSetSchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), candidateSetId: z.uuid(),
  planId: z.uuid(), judgmentSetHash: sha256Schema, policy: scoringPolicySchema, policyHash: sha256Schema,
  weightOverrides: z.array(z.object({ jobVersionId: z.uuid(), weights: scoreWeightsSchema }).strict()).max(20),
  results: z.array(scoreResultSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.weightOverrides.map(item => item.jobVersionId)).size !== value.weightOverrides.length
    || new Set(value.results.map(item => item.jobVersionId)).size !== value.results.length) ctx.addIssue({ code: 'custom', message: '岗位重复' });
});
export type ScoreSet = z.infer<typeof scoreSetSchema>;
