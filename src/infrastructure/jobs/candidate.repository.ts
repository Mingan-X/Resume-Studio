import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { candidateSetContentSchema, candidateSetSchema } from '../../contracts/candidates.js';
import { recallQuerySchema, recallResultSchema } from '../../contracts/recall.js';
import { corpusManifestSchema } from '../../contracts/job-corpus.js';
import { redactContactText } from '../../modules/models/privacy.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { ExecutionLeaseLostError } from '../consumer/contracts.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import { requireAnalysisAuthority } from '../tasks/analysis-artifact.repository.js';

async function readSet(tx: Prisma.TransactionClient, ownerId: string, taskId: string) {
  const row = await tx.candidateSet.findUnique({ where: { ownerId_taskId: { ownerId, taskId } }, include: { candidates: { orderBy: { rank: 'asc' } } } });
  if (!row) return null;
  const content = candidateSetContentSchema.parse(row.content);
  if (row.status !== 'FROZEN' || content.ownerId !== ownerId || content.taskId !== taskId || content.query.corpusVersion !== row.corpusVersion
    || requestHash(content) !== row.contentHash || requestHash(row.candidates.map(item => item.content)) !== requestHash(content.recall.candidates)) throw new Error('CANDIDATE_SET_INVALID');
  return candidateSetSchema.parse({ id: row.id, contentHash: row.contentHash, content, createdAt: row.createdAt.toISOString() });
}

export class CandidateRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async load(owner: string, task: string) {
    const ownerId = z.uuid().parse(owner), taskId = z.uuid().parse(task);
    return this.database.client.$transaction(tx => readSet(tx, ownerId, taskId));
  }
  async freeze(claim: ExecutionClaim, rawQuery: unknown, rawRecall: unknown) {
    if (claim.message.taskType !== 'analysis' || !claim.graph) throw new Error('ANALYSIS_TASK_REQUIRED');
    const ownerId = z.uuid().parse(claim.ownerId), taskId = z.uuid().parse(claim.message.taskId);
    const query = recallQuerySchema.parse(rawQuery), recall = recallResultSchema.parse(rawRecall);
    if (claim.snapshot.ownerId !== ownerId || claim.snapshot.embeddingVersion !== recall.embeddingVersion) throw new Error('CANDIDATE_INPUT_MISMATCH');
    if (claim.snapshot.kind === 'analysis') {
      const snapshot = realAnalysisInputSchema.parse(claim.snapshot);
      if (query.corpusVersion !== snapshot.jobCorpusVersionId || recall.corpusVersion !== snapshot.jobCorpusVersionId
        || recall.corpusHash !== snapshot.corpusHash || requestHash(recall.config) !== requestHash(snapshot.recall)
        || requestHash(recall.indexSpec) !== requestHash({ ...snapshot.indexTarget, ownerId })) throw new Error('CANDIDATE_INPUT_MISMATCH');
    }
    const content = candidateSetContentSchema.parse({ schemaVersion: 1, ownerId, taskId,
      query: { ...query, summary: redactContactText(query.summary), skills: query.skills.map(skill => redactContactText(skill)) }, recall });
    const contentHash = requestHash(content);
    return this.database.client.$transaction(async tx => {
      if (claim.snapshot.kind === 'analysis') await requireAnalysisAuthority(tx, claim);
      const valid = await tx.$queryRaw`SELECT id FROM analysis_task
        WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid AND status='RUNNING' AND cancel_requested=false
          AND generation=${claim.message.dispatchGeneration} AND fence_token=${claim.fenceToken} AND lease_owner=${claim.attemptId}::uuid
          AND lease_until>clock_timestamp() AND ${claim.deadline}>clock_timestamp()
          AND active_graph_thread_id=${claim.graph!.threadId}::uuid AND graph_generation=${claim.graph!.generation} FOR UPDATE`;
      if (z.array(z.object({ id: z.uuid() })).parse(valid).length !== 1) throw new ExecutionLeaseLostError();
      const existing = await readSet(tx, ownerId, taskId);
      if (existing) {
        if (existing.contentHash !== contentHash) throw new Error('CANDIDATE_SET_CONFLICT');
        return existing;
      }
      const corpus = await tx.jobCorpusVersion.findUnique({ where: { ownerId_version: { ownerId, version: query.corpusVersion } } });
      if (!corpus) throw new Error('CORPUS_NOT_FOUND');
      const manifest = corpusManifestSchema.parse(corpus.manifest);
      if (manifest.ownerId !== ownerId || requestHash(manifest) !== corpus.contentHash || corpus.contentHash !== recall.corpusHash) throw new Error('CORPUS_HASH_MISMATCH');
      const ids = recall.candidates.map(item => item.jobVersionId);
      // Version rows are locked through snapshot commit so a concurrent delete cannot race validation.
      const versions = z.array(z.object({ id: z.uuid(), jobId: z.uuid(), contentHash: z.string() })).parse(await tx.$queryRaw`
        SELECT id,job_id AS "jobId",content_hash AS "contentHash" FROM job_version
        WHERE owner_id=${ownerId}::uuid AND id=ANY(${ids}::uuid[]) AND status='PUBLISHED'
          AND (${query.city}::text IS NULL OR city=${query.city}::text) FOR SHARE`);
      for (const item of recall.candidates) {
        const version = versions.find(value => value.id === item.jobVersionId), member = manifest.members.find(value => value.jobVersionId === item.jobVersionId);
        if (!version || !member || version.jobId !== item.jobId || version.contentHash !== member.contentHash) throw new Error('CANDIDATE_NOT_VISIBLE');
      }
      const id = randomUUID();
      await tx.candidateSet.create({ data: { id, ownerId, taskId, corpusVersion: query.corpusVersion, content, contentHash } });
      if (recall.candidates.length) await tx.candidate.createMany({ data: recall.candidates.map(item => ({ ownerId, setId: id,
        jobVersionId: item.jobVersionId, rank: item.rank, content: item })) });
      const fresh = await tx.$queryRaw`SELECT id FROM analysis_task WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid
        AND lease_until>clock_timestamp() AND ${claim.deadline}>clock_timestamp()`;
      if (z.array(z.object({ id: z.uuid() })).parse(fresh).length !== 1) throw new ExecutionLeaseLostError();
      await tx.candidateSet.update({ where: { ownerId, id }, data: { status: 'FROZEN' } });
      const result = await readSet(tx, ownerId, taskId);
      if (!result) throw new Error('CANDIDATE_SET_MISSING');
      return result;
    });
  }
}
