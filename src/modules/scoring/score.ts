import { z } from 'zod';
import { jobRequirementSchema, dimensionIds } from '../../contracts/jobs.js';
import { requirementExecutionSchema } from '../../contracts/matching.js';
import { scoringPolicySchema, scoreWeightsSchema, scoreMetricsSchema } from '../../contracts/scoring.js';
import { requestHash } from '../tasks/request-hash.js';
import { add, decimal, divide, display, fraction, multiply, scaledHalfUp, serialize } from './rational.js';
import type { Fraction } from './rational.js';

const inputSchema = z.object({ jobVersionId: z.uuid(), requirements: z.array(jobRequirementSchema).max(400),
  executions: z.array(requirementExecutionSchema).max(400), weights: scoreWeightsSchema,
}).strict().superRefine((value, ctx) => {
  const ids = value.requirements.map(item => item.stableId), seen = new Set(ids);
  if (seen.size !== ids.length || new Set(value.executions.map(item => item.requirementId)).size !== ids.length
    || value.executions.length !== ids.length || value.weights.requirementWeights.length !== ids.length
    || value.weights.requirementWeights.some(item => !seen.has(item.requirementId))
    || value.executions.some(item => !seen.has(item.requirementId) || item.jobVersionId !== value.jobVersionId
      || item.status === 'DONE' && (item.judgment.jobVersionId !== item.jobVersionId || item.judgment.requirementId !== item.requirementId))) {
    ctx.addIssue({ code: 'custom', message: '要求、执行结果与权重必须一一对应' });
  }
});
export function calculateScoreMetrics(raw: unknown, rawPolicy: unknown) {
  const policy = scoringPolicySchema.parse(rawPolicy), input = inputSchema.parse(raw);
  const requirements = [...input.requirements].sort((a, b) => a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0);
  const dimensionWeights = dimensionIds.map(dimension => input.weights.dimensionWeights.find(item => item.dimension === dimension)!);
  const requirementWeights = requirements.map(item => input.weights.requirementWeights.find(weight => weight.requirementId === item.stableId)!);
  const weightsSnapshot = scoreWeightsSchema.parse({ dimensionWeights, requirementWeights });
  const executions = requirements.map(item => input.executions.find(value => value.requirementId === item.stableId)!);
  const judgmentSetHash = requestHash({ jobVersionId: input.jobVersionId, requirements, executions });
  const byDimension = new Map<string, { weight: Fraction; total: Fraction }>(); let dimensionTotal = fraction(0n);
  for (const entry of dimensionWeights) {
    const items = requirements.filter(item => item.dimension === entry.dimension);
    const weight = decimal(entry.weight);
    if (!items.length || weight.n === 0n) { byDimension.set(entry.dimension, { weight: fraction(0n), total: fraction(0n) }); continue; }
    const total = items.reduce((sum, item) => add(sum, decimal(requirementWeights.find(value => value.requirementId === item.stableId)!.weight)), fraction(0n));
    if (total.n === 0n) throw new Error('DIMENSION_REQUIREMENT_WEIGHT_ZERO');
    byDimension.set(entry.dimension, { weight, total }); dimensionTotal = add(dimensionTotal, weight);
  }
  if (requirements.length && dimensionTotal.n === 0n) throw new Error('PARTICIPATING_DIMENSION_WEIGHT_ZERO');
  let exactTotal = fraction(0n), knownWeight = fraction(0n), unresolvedWeight = fraction(0n);
  const contributions = requirements.map((item, index) => {
    const execution = executions[index]!, weights = byDimension.get(item.dimension)!;
    const normalized = weights.weight.n === 0n ? fraction(0n) : multiply(divide(weights.weight, dimensionTotal),
      divide(decimal(requirementWeights[index]!.weight), weights.total));
    const coefficient = execution.status === 'DONE' ? fraction(BigInt(policy.verdictCoefficients[execution.judgment.verdict]), 10000n) : fraction(0n);
    const contribution = multiply(multiply(normalized, coefficient), fraction(100n)); exactTotal = add(exactTotal, contribution);
    if (execution.status === 'DONE' && execution.judgment.verdict !== 'unknown') knownWeight = add(knownWeight, normalized);
    else unresolvedWeight = add(unresolvedWeight, normalized);
    return { requirementId: item.stableId, dimension: item.dimension, kind: item.kind, execution,
      normalizedWeight: serialize(normalized), exactContribution: serialize(contribution), contribution: display(contribution) };
  });
  const completed = executions.filter(item => item.status === 'DONE').length, incomplete = executions.length - completed;
  const unknown = executions.filter(item => item.status === 'DONE' && item.judgment.verdict === 'unknown').length;
  return scoreMetricsSchema.parse({ schemaVersion: 1, jobVersionId: input.jobVersionId, policyVersion: policy.version,
    policyHash: requestHash(policy), judgmentSetHash, weightsSnapshot,
    total: requirements.length ? display(exactTotal) : null, coverage: requirements.length ? display(multiply(knownWeight, fraction(100n))) : null,
    upperBound: requirements.length ? display(add(exactTotal, multiply(unresolvedWeight, fraction(100n)))) : null,
    sortValue: requirements.length ? scaledHalfUp(exactTotal, policy.rounding.sortDecimals) : null,
    planned: requirements.length, completed, incomplete, unknown, contributions });
}

