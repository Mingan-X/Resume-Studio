import { jobIndexInputSnapshotSchema } from '../../contracts/tasks.js';
import type { UsageReservation } from '../../contracts/tasks.js';
import { indexCollectionSchema, indexPointPayloadSchema, jobIndexCompletionSchema } from '../../contracts/job-index.js';
import type { EmbeddingExecutor } from '../embeddings/embedding-executor.js';
import { EmbeddingFailure } from '../embeddings/embedding.port.js';
import type { JobRepository } from '../../infrastructure/jobs/job.repository.js';
import type { JobIndexVector } from '../../infrastructure/vector/job-index.vector.js';
import type { ExecutionClaim } from '../../infrastructure/consumer/contracts.js';
import type { TaskHandler } from '../../infrastructure/consumer/task-delivery.handler.js';
import { TaskFailure } from '../../infrastructure/consumer/failure.js';
import { requestHash } from '../tasks/request-hash.js';
import { chunkJob, indexCollectionName, indexPointId } from './job-chunks.js';

export class JobIndexHandler implements TaskHandler {
  readonly capability = 'job-index';
  constructor(private readonly jobs: JobRepository, private readonly embedding: EmbeddingExecutor,
    private readonly vector: JobIndexVector, options: { allowSynthetic?: boolean } = {}) {
    if (embedding.provenance === 'synthetic' && options.allowSynthetic !== true) throw new Error('OFFICIAL_EMBEDDING_REQUIRED');
  }

  async execute(claim: ExecutionClaim, signal: AbortSignal, budget: { reserve: (usage: UsageReservation) => Promise<void> }) {
    signal.throwIfAborted();
    const snapshot = jobIndexInputSnapshotSchema.parse(claim.snapshot);
    if (claim.message.taskType !== 'job-index' || snapshot.kind !== 'job-index' || snapshot.ownerId !== claim.ownerId
      || snapshot.embeddingVersion !== this.embedding.embeddingVersion || snapshot.chunkerVersion !== 'jd-chunks-v1'
      || snapshot.componentVersion !== 'job-index-v1' || snapshot.budget.currency !== this.embedding.policy.currency) throw new TaskFailure('UNSUPPORTED_INPUT');
    const version = await this.jobs.findVersion(claim.ownerId, snapshot.jobVersionId);
    if (!version || version.status !== 'PUBLISHED' || version.document.textHash !== snapshot.contentHash
      || requestHash(version.requirements) !== snapshot.requirementsHash) throw new TaskFailure('INPUT_INVALID');
    const chunks = chunkJob(version.document);
    const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId: claim.ownerId,
      embeddingVersion: snapshot.embeddingVersion, indexVersion: snapshot.indexVersion, dimensions: this.embedding.dimensions,
      provenance: this.embedding.provenance, chunkerVersion: snapshot.chunkerVersion, componentVersion: snapshot.componentVersion });
    const call = { signal, deadline: claim.deadline.getTime() }, points: string[] = [];
    const guard = () => { signal.throwIfAborted(); if (Date.now() >= call.deadline) throw new TaskFailure('DEADLINE_EXCEEDED'); };
    guard(); await this.vector.ensure(spec, call);
    for (let offset = 0; offset < chunks.length; offset += 8) {
      guard();
      const batch = chunks.slice(offset, offset + 8);
      let embedded;
      try { embedded = await this.embedding.run(batch.map(chunk => chunk.text), { signal, deadline: call.deadline, reserve: budget.reserve }); }
      catch (error) {
        if (!(error instanceof EmbeddingFailure)) throw error;
        if (error.code === 'TIMEOUT') throw new TaskFailure('UPSTREAM_TIMEOUT');
        if (error.code === 'UNAVAILABLE' || error.code === 'BUSY' || error.code === 'UNSETTLED') throw new TaskFailure('DEPENDENCY_UNAVAILABLE');
        if (error.code === 'CANCELLED') { signal.throwIfAborted(); throw new TaskFailure('DEADLINE_EXCEEDED'); }
        throw new TaskFailure(error.code);
      }
      guard();
      const records = batch.map((chunk, index) => ({ id: indexPointId(version.id, chunk.chunkId, snapshot.embeddingVersion),
        vector: embedded.vectors[index]!, payload: indexPointPayloadSchema.parse({ schemaVersion: 1, kind: 'job-chunk',
          ownerId: claim.ownerId, visibility: snapshot.visibility, jobVersionId: version.id, chunkId: chunk.chunkId,
          embeddingVersion: snapshot.embeddingVersion, indexVersion: snapshot.indexVersion, contentHash: snapshot.contentHash,
          requirementsHash: snapshot.requirementsHash, chunkHash: chunk.contentHash }) }));
      await this.vector.upsert(spec, records, call); guard();
      points.push(...records.map(record => record.id));
    }
    return jobIndexCompletionSchema.parse({ schemaVersion: 1, kind: 'job-index', inputHash: requestHash(snapshot),
      completedUnits: points.length, collection: indexCollectionName(spec), spec, points });
  }
}
