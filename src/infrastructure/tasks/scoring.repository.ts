import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { requireAnalysisAuthority } from './analysis-artifact.repository.js';
import { scoringPolicySchema, scoreSetSchema, rankingResultSchema } from '../../contracts/scoring.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import { matchPlanSchema, requirementExecutionSchema } from '../../contracts/matching.js';
import { calculateScoreSet } from '../../modules/scoring/score-set.js';
import { rankScores } from '../../modules/scoring/rank.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

async function inputs(tx: Prisma.TransactionClient, ownerId: string, taskId: string) {
  const task = await tx.analysisTask.findFirst({ where: { ownerId, id: taskId } }); if (!task) throw new Error('SCORING_TASK_NOT_FOUND');
  const snapshot = realAnalysisInputSchema.parse(task.inputSnapshot);
  if (!snapshot.scoringPolicyHash) throw new Error('SCORING_NOT_ENABLED');
  const policyRow = await tx.scoringPolicy.findUnique({ where: { ownerId_version: { ownerId, version: snapshot.scoringVersion } } });
  if (!policyRow) throw new Error('SCORING_POLICY_NOT_FOUND');
  const policy = scoringPolicySchema.parse(policyRow.content);
  if (requestHash(policy) !== policyRow.contentHash || policyRow.contentHash !== snapshot.scoringPolicyHash) throw new Error('SCORING_POLICY_INVALID');
  const plan = await tx.matchPlan.findUnique({ where: { ownerId_taskId: { ownerId, taskId } }, include: { executions: { orderBy: { ordinal: 'asc' } } } });
  if (!plan) throw new Error('SCORING_PLAN_NOT_FOUND');
  const content = matchPlanSchema.parse(plan.content);
  if (requestHash(content) !== plan.contentHash || content.taskId !== taskId) throw new Error('SCORING_PLAN_INVALID');
  const executions = plan.executions.map(item => requirementExecutionSchema.parse({ jobVersionId: item.jobVersionId, requirementId: item.requirementId,
    ordinal: item.ordinal, status: item.status, judgment: item.judgment, errorCode: item.errorCode }));
  return { task, snapshot, policy, planId: plan.id, content, executions };
}
async function saveScore(tx: Prisma.TransactionClient, ownerId: string, content: z.infer<typeof scoreSetSchema>, sourceScoreSetId: string | null) {
  const contentHash = requestHash(content), operationKey = requestHash({ ownerId, contentHash, sourceScoreSetId });
  const prior = await tx.scoreSet.findUnique({ where: { operationKey } });
  if (prior) {
    if (prior.ownerId !== ownerId || prior.contentHash !== contentHash || requestHash(scoreSetSchema.parse(prior.content)) !== contentHash) throw new Error('SCORE_SET_CONFLICT');
    return { id: prior.id, content };
  }
  const id = randomUUID(); await tx.scoreSet.create({ data: { id, ownerId, taskId: content.taskId, policyVersion: content.policy.version, sourceScoreSetId,
    operationKey, content, contentHash } }); return { id, content };
}
async function saveRanking(tx: Prisma.TransactionClient, ownerId: string, scoreSetId: string, raw: unknown) {
  const score = scoreSetSchema.parse(raw), content = rankScores(score.results), contentHash = requestHash(content);
  const prior = await tx.rankingSnapshot.findUnique({ where: { scoreSetId } });
  if (prior) {
    if (prior.ownerId !== ownerId || prior.contentHash !== contentHash || requestHash(rankingResultSchema.parse(prior.content)) !== contentHash) throw new Error('RANKING_CONFLICT');
    return { id: prior.id, content };
  }
  const id = randomUUID(); await tx.rankingSnapshot.create({ data: { id, ownerId, scoreSetId, content, contentHash } }); return { id, content };
}
export class ScoringRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async score(claim: ExecutionClaim) {
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim); const value = await inputs(tx, claim.ownerId, claim.message.taskId);
      const content = calculateScoreSet(value.content, value.executions, value.planId, value.policy);
      await requireAnalysisAuthority(tx, claim); return saveScore(tx, claim.ownerId, content, null);
    });
  }
  async rank(claim: ExecutionClaim, scoreSetId: string) {
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const row = await tx.scoreSet.findFirst({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, id: z.uuid().parse(scoreSetId), sourceScoreSetId: null } });
      if (!row) throw new Error('SCORE_SET_NOT_FOUND'); const score = scoreSetSchema.parse(row.content);
      if (requestHash(score) !== row.contentHash) throw new Error('SCORE_SET_INVALID');
      return saveRanking(tx, claim.ownerId, row.id, score);
    });
  }
  async recompute(owner: string, sourceId: string, rawOverrides: unknown) {
    const ownerId = z.uuid().parse(owner), sourceScoreSetId = z.uuid().parse(sourceId);
    const overrides = scoreSetSchema.shape.weightOverrides.min(1).parse(rawOverrides);
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId,sourceScoreSetId])}, 26))::text`;
      const source = await tx.scoreSet.findFirst({ where: { ownerId, id: sourceScoreSetId } }); if (!source) throw new Error('SCORE_SET_NOT_FOUND');
      const original = scoreSetSchema.parse(source.content); if (requestHash(original) !== source.contentHash) throw new Error('SCORE_SET_INVALID');
      const value = await inputs(tx, ownerId, source.taskId);
      if (!['SUCCEEDED','PARTIAL'].includes(value.task.status)) throw new Error('RECOMPUTE_TASK_NOT_COMPLETE');
      if (new Set(overrides.map(item => item.jobVersionId)).size !== overrides.length || overrides.some(item => !original.results.some(result => result.jobVersionId === item.jobVersionId))) throw new Error('SCORING_OVERRIDE_INVALID');
      const weights = original.results.map(result => ({ jobVersionId: result.jobVersionId, weights: overrides.find(item => item.jobVersionId === result.jobVersionId)?.weights ?? result.weightsSnapshot }));
      const content = calculateScoreSet(value.content, value.executions, value.planId, value.policy, weights);
      if (content.judgmentSetHash !== original.judgmentSetHash || content.candidateSetId !== original.candidateSetId || content.policyHash !== original.policyHash) throw new Error('RECOMPUTE_INPUT_CHANGED');
      const score = await saveScore(tx, ownerId, content, source.id), ranking = await saveRanking(tx, ownerId, score.id, score.content);
      return { score, ranking };
    });
  }
}
