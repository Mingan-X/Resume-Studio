import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import { parsedResumeSchema } from '../../contracts/parsed-resume.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { requireAnalysisAuthority } from './analysis-artifact.repository.js';
import { TaskFailure } from '../consumer/failure.js';

export class ResumeExtractionRepository {
  constructor(private readonly database: TransactionDatabase, private readonly pool: Pool) {}
  private key(claim: ExecutionClaim) {
    const input = realAnalysisInputSchema.parse(claim.snapshot);
    return { ownerId: input.ownerId, resumeVersionId: input.resumeVersionId, promptVersion: input.promptVersion,
      modelConfigVersion: input.modelConfigVersion, schemaVersion: 1 };
  }
  async load(claim: ExecutionClaim, inputHash: string) {
    const key = this.key(claim);
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const row = await tx.resumeExtraction.findUnique({ where: { ownerId_resumeVersionId_promptVersion_modelConfigVersion_schemaVersion: key } });
      if (!row) return null;
      const content = parsedResumeSchema.parse(row.content);
      if (row.inputHash !== inputHash || content.resumeVersionId !== key.resumeVersionId || requestHash(content) !== row.contentHash) throw new Error('EXTRACTION_CACHE_INVALID');
      return { id: row.id, content };
    });
  }
  async save(claim: ExecutionClaim, inputHash: string, raw: unknown) {
    const key = this.key(claim), content = parsedResumeSchema.parse(raw), contentHash = requestHash(content);
    if (content.resumeVersionId !== key.resumeVersionId) throw new TaskFailure('OUTPUT_INVALID');
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const row = await tx.resumeExtraction.findUnique({ where: { ownerId_resumeVersionId_promptVersion_modelConfigVersion_schemaVersion: key } });
      if (row) {
        if (row.inputHash !== inputHash || row.contentHash !== contentHash || requestHash(parsedResumeSchema.parse(row.content)) !== contentHash) throw new Error('EXTRACTION_CACHE_CONFLICT');
        return { id: row.id, content };
      }
      const id = randomUUID(); await tx.resumeExtraction.create({ data: { id, ...key, inputHash, contentHash, content } });
      return { id, content };
    });
  }
  async exclusive<T>(claim: ExecutionClaim, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
    // Session advisory lock, never a DB transaction held over the model request. Same resume/version across tasks shares this lock.
    const digest = requestHash(this.key(claim)), lock = Buffer.from(digest.slice(0, 16), 'hex').readBigInt64BE().toString();
    signal.throwIfAborted(); const client = await this.pool.connect(), lost = new AbortController();
    const stop = () => lost.abort(); client.on('error', stop); client.on('end', stop);
    let acquired = false, discard = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [lock]);
      acquired = z.array(z.object({ acquired: z.boolean() })).length(1).parse(result.rows)[0]!.acquired;
      if (!acquired) throw new TaskFailure('DEPENDENCY_UNAVAILABLE');
      const combined = AbortSignal.any([signal, lost.signal]); combined.throwIfAborted();
      const output = await work(combined); combined.throwIfAborted(); return output;
    } catch (error) { if (!acquired || lost.signal.aborted) discard = true; throw error; }
    finally {
      try { if (acquired && !lost.signal.aborted) {
        const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [lock]);
        if (!z.array(z.object({ unlocked: z.boolean() })).length(1).parse(result.rows)[0]!.unlocked) discard = true;
      } } catch { discard = true; }
      client.off('error', stop); client.off('end', stop); client.release(discard || lost.signal.aborted);
    }
  }
}
