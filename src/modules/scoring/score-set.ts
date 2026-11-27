import { z } from 'zod';
import { matchPlanSchema, requirementExecutionSchema } from '../../contracts/matching.js';
import { scoringPolicySchema, scoreSetSchema } from '../../contracts/scoring.js';
import { requestHash } from '../tasks/request-hash.js';
import { calculateScore } from './score.js';

export function calculateScoreSet(rawPlan: unknown, rawExecutions: unknown, planId: string, rawPolicy: unknown, rawOverrides: unknown = []) {
  const plan = matchPlanSchema.parse(rawPlan), policy = scoringPolicySchema.parse(rawPolicy);
  const executions = z.array(requirementExecutionSchema).max(8000).parse(rawExecutions);
  const weightOverrides = scoreSetSchema.shape.weightOverrides.parse(rawOverrides);
  if (executions.length !== plan.requirements.length || new Set(executions.map(item => JSON.stringify([item.jobVersionId,item.requirementId]))).size !== executions.length
    || executions.some(item => !plan.requirements.some(req => req.jobVersionId === item.jobVersionId && req.requirementId === item.requirementId && req.ordinal === item.ordinal
      && (req.allocated || item.status === 'BUDGET')))) throw new Error('SCORING_EXECUTIONS_INVALID');
  if (new Set(weightOverrides.map(item => item.jobVersionId)).size !== weightOverrides.length || weightOverrides.some(item => !plan.jobs.some(job => job.id === item.jobVersionId))) throw new Error('SCORING_OVERRIDE_INVALID');
  const ordered = [...executions].sort((a, b) => a.ordinal-b.ordinal), judgmentSetHash = requestHash({ plan, executions: ordered });
  const results = plan.jobs.map(job => calculateScore({ jobVersionId: job.id, requirements: job.requirements,
    executions: ordered.filter(item => item.jobVersionId === job.id), weights: weightOverrides.find(item => item.jobVersionId === job.id)?.weights ?? {
      dimensionWeights: policy.dimensionWeights, requirementWeights: job.requirements.map(item => ({ requirementId: item.stableId, weight: item.weight })),
    } }, policy));
  return scoreSetSchema.parse({ schemaVersion: 1, taskId: plan.taskId, candidateSetId: plan.candidateSetId, planId: z.uuid().parse(planId),
    judgmentSetHash, policy, policyHash: requestHash(policy), weightOverrides: [...weightOverrides].sort((a,b) => a.jobVersionId < b.jobVersionId ? -1 : 1), results });
}
