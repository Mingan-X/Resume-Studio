import { randomUUID } from 'node:crypto';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { requireAnalysisAuthority } from './analysis-artifact.repository.js';
import { matchPlanSchema, requirementExecutionSchema, storedJudgmentSchema } from '../../contracts/matching.js';
import { taskFailureCodeSchema } from '../../contracts/tasks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { candidateSetContentSchema } from '../../contracts/candidates.js';
import { z } from 'zod';

export class MatchingRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async load(claim: ExecutionClaim) {
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const row = await tx.matchPlan.findUnique({ where: { ownerId_taskId: { ownerId: claim.ownerId, taskId: claim.message.taskId } },
        include: { executions: { orderBy: { ordinal: 'asc' } } } });
      if (!row) return null;
      const content = matchPlanSchema.parse(row.content);
      if (content.taskId !== claim.message.taskId || requestHash(content) !== row.contentHash || row.executions.length !== content.requirements.length) throw new Error('MATCH_PLAN_INVALID');
      const executions = row.executions.map(row => requirementExecutionSchema.parse({ jobVersionId: row.jobVersionId,
        requirementId: row.requirementId, ordinal: row.ordinal, status: row.status, judgment: row.judgment, errorCode: row.errorCode }));
      for (const [index, item] of executions.entries()) {
        const planned = content.requirements[index]!;
        if (item.jobVersionId !== planned.jobVersionId || item.requirementId !== planned.requirementId || item.ordinal !== planned.ordinal
          || (!planned.allocated && item.status !== 'BUDGET')
          || (item.status === 'DONE' && (item.judgment.jobVersionId !== item.jobVersionId || item.judgment.requirementId !== item.requirementId))) throw new Error('MATCH_PLAN_INVALID');
      }
      return { id: row.id, content, executions };
    });
  }
  async prepare(claim: ExecutionClaim, raw: unknown) {
    const content = matchPlanSchema.parse(raw), contentHash = requestHash(content);
    await this.database.client.$transaction(async tx => {
      const snapshot = await requireAnalysisAuthority(tx, claim);
      if (content.taskId !== claim.message.taskId || content.maxJudgments !== snapshot.maxJudgments) throw new Error('MATCH_INPUT_MISMATCH');
      const set = await tx.candidateSet.findFirst({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, id: content.candidateSetId, status: 'FROZEN' } });
      if (!set || set.contentHash !== content.candidateSetHash) throw new Error('MATCH_CANDIDATES_MISSING');
      const candidates = candidateSetContentSchema.parse(set.content).recall.candidates;
      if (content.jobs.length !== candidates.length || content.jobs.some((job, index) => job.id !== candidates[index]?.jobVersionId || job.ownerId !== claim.ownerId)) throw new Error('MATCH_CANDIDATES_MISMATCH');
      const extraction = await tx.resumeExtraction.findFirst({ where: { id: content.extractionId, ownerId: claim.ownerId, resumeVersionId: snapshot.resumeVersionId } });
      if (!extraction) throw new Error('MATCH_EXTRACTION_MISSING');
      const prior = await tx.matchPlan.findUnique({ where: { ownerId_taskId: { ownerId: claim.ownerId, taskId: claim.message.taskId } } });
      if (prior) { if (prior.contentHash !== contentHash) throw new Error('MATCH_PLAN_CONFLICT'); return; }
      const id = randomUUID(); await tx.matchPlan.create({ data: { id, ownerId: claim.ownerId, taskId: claim.message.taskId, content, contentHash } });
      if (content.requirements.length) await tx.requirementExecution.createMany({ data: content.requirements.map(item => ({ ownerId: claim.ownerId, planId: id,
        jobVersionId: item.jobVersionId, requirementId: item.requirementId, ordinal: item.ordinal,
        status: item.allocated ? 'PENDING' : 'BUDGET', errorCode: item.allocated ? null : 'BUDGET_EXHAUSTED' })) });
    });
    const result = await this.load(claim); if (!result) throw new Error('MATCH_PLAN_MISSING'); return result;
  }
  async completeBatch(claim: ExecutionClaim, planId: string, raw: unknown) {
    const judgments = z.array(storedJudgmentSchema).min(1).max(10).parse(raw);
    if (new Set(judgments.map(item => JSON.stringify([item.jobVersionId, item.requirementId]))).size !== judgments.length) throw new Error('DUPLICATE_JUDGMENT');
    await this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const plan = await tx.matchPlan.findFirst({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, id: planId } });
      if (!plan) throw new Error('MATCH_PLAN_MISSING');
      for (const judgment of judgments) {
        const key = { planId_jobVersionId_requirementId: { planId, jobVersionId: judgment.jobVersionId, requirementId: judgment.requirementId } };
        const row = await tx.requirementExecution.findUnique({ where: key });
        if (!row) throw new Error('UNKNOWN_REQUIREMENT');
        if (row.status === 'DONE') { if (requestHash(storedJudgmentSchema.parse(row.judgment)) !== requestHash(judgment)) throw new Error('JUDGMENT_CONFLICT'); continue; }
        if (row.status !== 'PENDING') throw new Error('REQUIREMENT_NOT_ALLOCATED');
        await tx.requirementExecution.update({ where: key, data: { status: 'DONE', judgment } });
      }
    });
  }
  async failBatch(claim: ExecutionClaim, planId: string, jobVersionId: string, rawIds: unknown, rawCode: unknown) {
    const ids = z.array(z.string()).max(400).parse(rawIds), errorCode = taskFailureCodeSchema.parse(rawCode);
    await this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const plan = await tx.matchPlan.findFirst({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId, id: planId } });
      if (!plan) throw new Error('MATCH_PLAN_MISSING');
      await tx.requirementExecution.updateMany({ where: { ownerId: claim.ownerId, planId, jobVersionId,
        requirementId: { in: ids }, status: 'PENDING' }, data: { status: 'FAILED', errorCode } });
    });
  }
}
