import { z } from 'zod';
import type { DatabaseService } from '../database/database.service.js';
import { JobCorpusRepository } from './corpus.repository.js';
import { indexCollectionSchema, jobIndexCompletionSchema } from '../../contracts/job-index.js';
import { jobIndexInputSnapshotSchema } from '../../contracts/tasks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { indexCollectionName } from '../../modules/recall/job-chunks.js';
import { versionNameSchema } from '../../contracts/jobs.js';

export class JobIndexRepository {
  constructor(private readonly database: DatabaseService) {}
  async validCandidates(owner: string, corpus: string, rawIds: unknown, rawCity: unknown) {
    const ownerId = z.uuid().parse(owner), ids = z.array(z.uuid()).max(200).parse(rawIds), city = z.string().trim().min(1).max(128).nullable().parse(rawCity);
    const corpusVersion = versionNameSchema.parse(corpus);
    return z.array(z.object({ jobId: z.uuid(), jobVersionId: z.uuid() }).strict()).parse(await this.database.client.$queryRaw`
      SELECT v.job_id AS "jobId", v.id AS "jobVersionId"
      FROM job_corpus_version c CROSS JOIN LATERAL jsonb_array_elements(c.manifest->'members') member
      JOIN job_version v ON v.owner_id=c.owner_id AND v.id=(member->>'jobVersionId')::uuid
      WHERE c.owner_id=${ownerId}::uuid AND c.version=${corpusVersion} AND c.visibility='private'
        AND v.id=ANY(${ids}::uuid[]) AND v.status='PUBLISHED' AND v.content_hash=member->>'contentHash'
        AND (${city}::text IS NULL OR v.city=${city}::text)
    `);
  }
  async visibleVersions(owner: string, rawIds: unknown, rawCity: unknown = null) {
    const ownerId = z.uuid().parse(owner), ids = z.array(z.uuid()).max(10_000).parse(rawIds), city = z.string().nullable().parse(rawCity);
    return this.database.client.jobVersion.findMany({ where: { ownerId, id: { in: ids }, status: 'PUBLISHED', ...(city === null ? {} : { city }) },
      select: { id: true, jobId: true, contentHash: true, document: true } });
  }
  async assertCorpusReady(owner: string, corpusVersion: string, rawSpec: unknown) {
    const ownerId = z.uuid().parse(owner), spec = indexCollectionSchema.parse(rawSpec);
    if (spec.ownerId !== ownerId) throw new Error('INDEX_NOT_READY');
    const corpus = await new JobCorpusRepository(this.database).load(ownerId, corpusVersion);
    if (!corpus) throw new Error('CORPUS_NOT_FOUND');
    const ids = corpus.manifest.members.map(member => member.jobVersionId);
    const rows = z.array(z.object({ id: z.uuid(), contentHash: z.string(), output: z.unknown(), snapshot: z.unknown() })).parse(
      await this.database.client.$queryRaw`
        SELECT v.id, v.content_hash AS "contentHash", a.validated_output AS output, task.input_snapshot AS snapshot
        FROM job_version v JOIN job_index_target target ON target.owner_id=v.owner_id AND target.job_version_id=v.id
        JOIN job_index_task task ON task.owner_id=target.owner_id AND task.id=target.task_id
        JOIN node_artifact a ON a.owner_id=task.owner_id AND a.job_index_task_id=task.id AND a.node='job-index'
        WHERE v.owner_id=${ownerId}::uuid AND v.id=ANY(${ids}::uuid[]) AND v.status='PUBLISHED' AND v.index_status='READY'
          AND task.status='SUCCEEDED' AND target.embedding_version=${spec.embeddingVersion} AND target.index_version=${spec.indexVersion}
      `);
    if (rows.length !== ids.length) throw new Error('INDEX_NOT_READY');
    for (const row of rows) {
      const member = corpus.manifest.members.find(item => item.jobVersionId === row.id);
      const output = jobIndexCompletionSchema.parse(row.output), snapshot = jobIndexInputSnapshotSchema.parse(row.snapshot);
      if (!member || row.contentHash !== member.contentHash || snapshot.kind !== 'job-index' || snapshot.ownerId !== ownerId
        || snapshot.jobVersionId !== row.id || output.inputHash !== requestHash(snapshot)
        || output.collection !== indexCollectionName(spec) || requestHash(output.spec) !== requestHash(spec)) throw new Error('INDEX_NOT_READY');
    }
    return { corpus, collection: indexCollectionName(spec) };
  }
}
