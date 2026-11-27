import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { ExecutionLeaseLostError } from '../consumer/contracts.js';
import { requireAnalysisAuthority } from './analysis-artifact.repository.js';
import { analysisSummarySchema, analysisCompletionSchema } from '../../contracts/analysis-summary.js';
import { taskCountsSchema, taskFailureCodeSchema, realAnalysisInputSchema } from '../../contracts/tasks.js';
import { scoreSetSchema, rankingResultSchema } from '../../contracts/scoring.js';
import { rankScores } from '../../modules/scoring/rank.js';
import { profileAssessmentSchema } from '../../contracts/profile.js';
import { matchPlanSchema, requirementExecutionSchema } from '../../contracts/matching.js';
import { candidateSetContentSchema } from '../../contracts/candidates.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { analysisNodeArtifactSchema } from '../../contracts/analysis-graph.js';
import { insertFinalReport } from './report-snapshot.js';

async function summarize(tx: Prisma.TransactionClient, claim: ExecutionClaim, errors: { profileError: unknown; matchingError: unknown }) {
  const where = { ownerId_taskId: { ownerId: claim.ownerId, taskId: claim.message.taskId } };
  const profile = await tx.profileAssessment.findUnique({ where }), candidates = await tx.candidateSet.findUnique({ where });
  const plan = await tx.matchPlan.findUnique({ where, include: { executions: { orderBy: { ordinal: 'asc' } } } });
  if (profile && requestHash(profileAssessmentSchema.parse(profile.content)) !== profile.contentHash) throw new Error('PROFILE_INVALID');
  const candidateContent = candidates ? candidateSetContentSchema.parse(candidates.content) : null;
  if (candidates && (candidates.status !== 'FROZEN' || requestHash(candidateContent) !== candidates.contentHash)) throw new Error('CANDIDATES_INVALID');
  const planContent = plan ? matchPlanSchema.parse(plan.content) : null;
  if (plan && (!planContent || requestHash(planContent) !== plan.contentHash || planContent.candidateSetId !== candidates?.id || plan.executions.length !== planContent.requirements.length)) throw new Error('MATCH_PLAN_INVALID');
  const executions = plan?.executions.map(row => requirementExecutionSchema.parse({ jobVersionId: row.jobVersionId,
    requirementId: row.requirementId, ordinal: row.ordinal, status: row.status, judgment: row.judgment, errorCode: row.errorCode })) ?? [];
  const planned = executions.length, completed = executions.filter(row => row.status === 'DONE').length,
    failed = executions.filter(row => row.status === 'FAILED').length, truncated = executions.filter(row => row.status === 'BUDGET').length,
    pending = executions.filter(row => row.status === 'PENDING').length;
  const profileError = taskFailureCodeSchema.nullable().parse(errors.profileError), matchingError = taskFailureCodeSchema.nullable().parse(errors.matchingError);
  const snapshot = realAnalysisInputSchema.parse(claim.snapshot);
  let scoring: { scoreSetId: string | null; rankingId: string | null } | undefined;
  if (snapshot.scoringPolicyHash) {
    const score = await tx.scoreSet.findFirst({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, sourceScoreSetId: null }, include: { ranking: true } });
    if (plan && !matchingError && !score?.ranking) throw new Error('SCORING_ARTIFACTS_MISSING');
    if (score) {
      const content = scoreSetSchema.parse(score.content);
      if (requestHash(content) !== score.contentHash || content.policyHash !== snapshot.scoringPolicyHash || content.planId !== plan?.id
        || content.judgmentSetHash !== requestHash({ plan: planContent, executions })) throw new Error('SCORING_ARTIFACTS_INVALID');
      if (!score.ranking || requestHash(rankingResultSchema.parse(score.ranking.content)) !== score.ranking.contentHash
        || requestHash(rankScores(content.results)) !== score.ranking.contentHash) throw new Error('RANKING_ARTIFACTS_INVALID');
    }
    scoring = { scoreSetId: score?.id ?? null, rankingId: score?.ranking?.id ?? null };
  }
  const profileAvailable = !!profile && !profileError, matchingAvailable = !!plan && !!candidates && !matchingError && (planned === 0 || completed > 0);
  const degraded = candidateContent?.recall.degraded ?? false;
  const status = !profileAvailable && !matchingAvailable ? 'FAILED' : profileAvailable && matchingAvailable && failed + truncated + pending === 0 && !degraded ? 'SUCCEEDED' : 'PARTIAL';
  return analysisSummarySchema.parse({ schemaVersion: 1, taskId: claim.message.taskId, inputHash: requestHash(claim.snapshot), status,
    profileId: profile?.id ?? null, candidateSetId: candidates?.id ?? null, matchPlanId: plan?.id ?? null,
    profileError, matchingError, degraded, planned, completed, failed, truncated, pending, ...scoring });
}

export class AnalysisSummaryRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async prepare(claim: ExecutionClaim, errors: { profileError: unknown; matchingError: unknown }) {
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const content = await summarize(tx, claim, errors), contentHash = requestHash(content);
      const prior = await tx.analysisSummary.findUnique({ where: { ownerId_taskId: { ownerId: claim.ownerId, taskId: claim.message.taskId } } });
      if (prior) {
        if (prior.contentHash !== contentHash || requestHash(analysisSummarySchema.parse(prior.content)) !== contentHash) throw new Error('SUMMARY_CONFLICT');
        return { id: prior.id, content };
      }
      const id = randomUUID(); await tx.analysisSummary.create({ data: { id, ownerId: claim.ownerId, taskId: claim.message.taskId, content, contentHash } });
      return { id, content };
    });
  }
  async progress(claim: ExecutionClaim, rawStage: unknown, rawCounts: unknown) {
    const stage = z.enum(['LOAD','PARSE','EXTRACT','VALIDATE','PROFILE','RECALL','SNAP','MATCH','SCORE','RANK','JOIN','SAVE','FINALIZE']).parse(rawStage), counts = taskCountsSchema.parse(rawCounts);
    await this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const previous = await tx.taskEvent.findFirst({ where: { ownerId: claim.ownerId, taskType: 'ANALYSIS', taskId: claim.message.taskId }, orderBy: { seq: 'desc' } });
      await tx.analysisTask.update({ where: { id: claim.message.taskId, ownerId: claim.ownerId }, data: { stage } });
      await tx.taskEvent.create({ data: { id: randomUUID(), ownerId: claim.ownerId, taskType: 'ANALYSIS', taskId: claim.message.taskId,
        analysisTaskId: claim.message.taskId, seq: (previous?.seq ?? 0) + 1, stage, safeMessage: 'Analysis stage progressed', counts } });
    });
  }
  async complete(claim: ExecutionClaim, raw: unknown) {
    const output = analysisCompletionSchema.parse(raw);
    if (output.inputHash !== requestHash(claim.snapshot)) throw new Error('ANALYSIS_INPUT_MISMATCH');
    await this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const row = await tx.analysisSummary.findFirst({ where: { id: output.summaryId, ownerId: claim.ownerId, taskId: claim.message.taskId } });
      if (!row) throw new Error('SUMMARY_MISSING');
      const content = analysisSummarySchema.parse(row.content), current = await summarize(tx, claim, content);
      if (requestHash(content) !== row.contentHash || requestHash(current) !== row.contentHash) throw new Error('SUMMARY_INVALID');
      const reportEnabled=!!realAnalysisInputSchema.parse(claim.snapshot).reportVersion;
      const final = await tx.nodeArtifact.findMany({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, taskType: 'ANALYSIS', node: reportEnabled?'SAVE':'FINALIZE', branchKey: 'root' } });
      if (final.length !== 1) throw new Error('FINALIZE_ARTIFACT_MISSING');
      const artifact = analysisNodeArtifactSchema.parse(final[0]!.validatedOutput);
      if (artifact.result.status !== 'ok' || artifact.result.artifactId !== row.id) throw new Error('FINALIZE_ARTIFACT_INVALID');
      const now = z.array(z.object({ now: z.date() })).length(1).parse(await tx.$queryRaw`SELECT clock_timestamp() AS now`)[0]!.now;
      // Recheck after all reads: waiting on SQL must not authorize output beyond the lease/deadline.
      await requireAnalysisAuthority(tx, claim);
      const reportId=reportEnabled?await insertFinalReport(tx,claim,content):null;
      await requireAnalysisAuthority(tx, claim);
      await tx.analysisTask.update({ where: { id: claim.message.taskId, ownerId: claim.ownerId }, data: {
        status: content.status, stage: content.status, errorCode: content.status === 'FAILED' ? 'EXECUTION_FAILED' : null,
        leaseOwner: null, leaseUntil: null, reportId,
      } });
      await tx.$executeRaw`UPDATE analysis_task SET budget_usage=jsonb_set(budget_usage,'{elapsedMs}',to_jsonb((budget_usage->>'elapsedMs')::bigint + ${Math.max(0, now.getTime() - claim.startedAt.getTime())}::bigint)) WHERE id=${claim.message.taskId}::uuid`;
      const previous = await tx.taskEvent.findFirst({ where: { ownerId: claim.ownerId, taskType: 'ANALYSIS', taskId: claim.message.taskId }, orderBy: { seq: 'desc' } });
      await tx.taskEvent.create({ data: { id: randomUUID(), ownerId: claim.ownerId, taskType: 'ANALYSIS', taskId: claim.message.taskId,
        analysisTaskId: claim.message.taskId, seq: (previous?.seq ?? 0) + 1, stage: content.status, safeMessage: 'Analysis artifacts committed',
        counts: taskCountsSchema.parse({ schemaVersion: 1, planned: content.planned, completed: content.completed, failed: content.failed }) } });
      const attempt = await tx.taskAttempt.updateMany({ where: { ownerId: claim.ownerId, attemptId: claim.attemptId, taskId: claim.message.taskId,
        taskType: 'ANALYSIS', fenceToken: claim.fenceToken, endedAt: null }, data: { endedAt: now } });
      const receipt = await tx.consumerReceipt.updateMany({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, taskType: 'ANALYSIS',
        consumerName: claim.consumerName, messageId: claim.message.messageId, generation: claim.message.dispatchGeneration, leaseOwner: claim.attemptId, status: 'RUNNING' },
        data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
      if (attempt.count !== 1 || receipt.count !== 1) throw new ExecutionLeaseLostError();
    });
  }
}
