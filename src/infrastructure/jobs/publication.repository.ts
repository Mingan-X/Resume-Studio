import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import type { TransactionDatabase } from '../database/transaction-port.js';
import { readJobVersion } from './job.repository.js';
import { jobScoringInputSchema } from '../../contracts/jobs.js';
import { jobConfirmationSchema, jobIndexTargetSchema, jobPublicationResultSchema } from '../../contracts/job-publication.js';
import { budgetUsageSchema, idempotencyKeySchema, jobIndexInputSnapshotSchema, taskDispatchSchema } from '../../contracts/tasks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { IdempotencyConflictError } from '../../modules/tasks/task-errors.js';

@Injectable()
export class JobPublicationRepository {
  constructor(@Inject(DatabaseService) private readonly database: TransactionDatabase) {}

  async confirm(owner: string, version: string, input: unknown) {
    const ownerId = z.uuid().parse(owner), id = z.uuid().parse(version), confirmation = jobConfirmationSchema.parse(input);
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM job_version WHERE owner_id=${ownerId}::uuid AND id=${id}::uuid FOR UPDATE`;
      const draft = await readJobVersion(tx, ownerId, id);
      if (!draft) throw new Error('JOB_NOT_FOUND');
      if (draft.status !== 'DRAFT') throw new Error('JOB_INVALID_STATE');
      jobScoringInputSchema.parse({ requirements: draft.requirements, dimensionWeights: draft.dimensionWeights });
      await tx.jobVersion.update({ where: { ownerId, id }, data: confirmation });
      return { ...draft, ...confirmation };
    });
  }

  async publish(owner: string, version: string, key: string, rawTarget: unknown) {
    const ownerId = z.uuid().parse(owner), id = z.uuid().parse(version), idempotencyKey = idempotencyKeySchema.parse(key);
    const hash = requestHash({ operation: 'publish-job-v1', jobVersionId: id });
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, idempotencyKey])}, 22))::text`;
      if (await tx.jobIndexRequest.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } })) throw new IdempotencyConflictError();
      const prior = await tx.jobIndexTask.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } });
      if (prior) {
        const snapshot = jobIndexInputSnapshotSchema.parse(prior.inputSnapshot);
        if (prior.requestHash !== hash || snapshot.kind !== 'job-index' || snapshot.ownerId !== ownerId || snapshot.jobVersionId !== id) throw new IdempotencyConflictError();
        return jobPublicationResultSchema.parse({ jobVersionId: id, taskId: prior.id });
      }
      await tx.$queryRaw`SELECT id FROM job_version WHERE owner_id=${ownerId}::uuid AND id=${id}::uuid FOR UPDATE`;
      const draft = await readJobVersion(tx, ownerId, id);
      if (!draft) throw new Error('JOB_NOT_FOUND');
      if (draft.status !== 'DRAFT' || !draft.hardRequirementsConfirmed || !draft.weightsConfirmed) throw new Error('JOB_NOT_CONFIRMED');
      jobScoringInputSchema.parse({ requirements: draft.requirements, dimensionWeights: draft.dimensionWeights });
      if (rawTarget === undefined || rawTarget === null) throw new Error('JOB_INDEX_TARGET_UNAVAILABLE');
      const target = jobIndexTargetSchema.parse(rawTarget), taskId = randomUUID(), eventId = randomUUID();
      const snapshot = jobIndexInputSnapshotSchema.parse({ schemaVersion: 1, kind: 'job-index', ownerId,
        visibility: 'private', jobVersionId: id, contentHash: draft.document.textHash,
        requirementsHash: requestHash(draft.requirements), ...target,
      });
      const contentHash = requestHash({ schemaVersion: 1, ownerId, jobId: draft.jobId, jobVersionId: id,
        version: draft.version, title: draft.title, city: draft.city, level: draft.level, skills: draft.skills,
        document: draft.document, requirements: draft.requirements, dimensionWeights: draft.dimensionWeights,
      });
      await tx.jobVersion.update({ where: { ownerId, id }, data: { status: 'PUBLISHED', contentHash,
        publishedAt: new Date(), indexStatus: 'PENDING' } });
      await tx.jobIndexTask.create({ data: { id: taskId, ownerId, jobVersionId: id, realJobVersionId: id,
        embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion, inputSnapshot: snapshot,
        idempotencyKey, requestHash: hash,
        budgetUsage: budgetUsageSchema.parse({ schemaVersion: 1, attempts: 0, modelCalls: 0, tokens: 0, costMicros: 0, elapsedMs: 0 }),
      } });
      await tx.jobIndexTarget.create({ data: { ownerId, jobVersionId: id, taskId,
        embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion } });
      await tx.outboxEvent.create({ data: { eventId, ownerId, aggregateType: 'JobIndexTask', aggregateId: taskId,
        eventType: 'job.index.requested.v1', payloadVersion: 1,
        payload: taskDispatchSchema.parse({ schemaVersion: 1, messageId: eventId, taskType: 'job-index', taskId,
          dispatchGeneration: 1, occurredAt: new Date().toISOString() }),
      } });
      return jobPublicationResultSchema.parse({ jobVersionId: id, taskId });
    });
  }

  // Administrative backfill: callers use a stable per-version key for one explicit run.
  // A matching current target is already scheduled; changing a target requires a fresh run key.
  async ensureIndex(owner: string, version: string, key: string, rawTarget: unknown) {
    const ownerId = z.uuid().parse(owner), id = z.uuid().parse(version), idempotencyKey = idempotencyKeySchema.parse(key);
    const target = jobIndexTargetSchema.parse(rawTarget), hash = requestHash({ operation: 'ensure-job-index-v1', jobVersionId: id, target });
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, idempotencyKey])}, 22))::text`;
      const request = await tx.jobIndexRequest.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } });
      if (request) {
        if (request.requestHash !== hash) throw new IdempotencyConflictError();
        return { jobVersionId: id, taskId: request.taskId, created: false };
      }
      const prior = await tx.jobIndexTask.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } });
      if (prior && prior.requestHash !== hash) throw new IdempotencyConflictError();
      // Adopt pre-migration created-task requests without touching the current target.
      if (prior) {
        const snapshot = jobIndexInputSnapshotSchema.parse(prior.inputSnapshot);
        if (snapshot.kind !== 'job-index' || snapshot.ownerId !== ownerId || snapshot.jobVersionId !== id) throw new IdempotencyConflictError();
        await tx.jobIndexRequest.create({ data: { ownerId, idempotencyKey, requestHash: hash, taskId: prior.id } });
        return { jobVersionId: id, taskId: prior.id, created: false };
      }
      await tx.$queryRaw`SELECT id FROM job_version WHERE owner_id=${ownerId}::uuid AND id=${id}::uuid FOR UPDATE`;
      const published = await readJobVersion(tx, ownerId, id);
      if (!published || published.status !== 'PUBLISHED') throw new Error('PUBLISHED_JOB_REQUIRED');
      const snapshot = jobIndexInputSnapshotSchema.parse({ schemaVersion: 1, kind: 'job-index', ownerId, visibility: 'private',
        jobVersionId: id, contentHash: published.document.textHash, requirementsHash: requestHash(published.requirements), ...target });
      const current = await tx.jobIndexTarget.findUnique({ where: { ownerId_jobVersionId: { ownerId, jobVersionId: id } } });
      if (current) {
        const task = await tx.jobIndexTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: current.taskId } } });
        const original = jobIndexInputSnapshotSchema.parse(task.inputSnapshot);
        if (requestHash(original) === requestHash(snapshot)) {
          await tx.jobIndexRequest.create({ data: { ownerId, idempotencyKey, requestHash: hash, taskId: task.id } });
          return { jobVersionId: id, taskId: task.id, created: false };
        }
      }
      const taskId = randomUUID(), eventId = randomUUID();
      await tx.jobIndexTask.create({ data: { id: taskId, ownerId, jobVersionId: id, realJobVersionId: id,
        embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion, inputSnapshot: snapshot,
        idempotencyKey, requestHash: hash,
        budgetUsage: budgetUsageSchema.parse({ schemaVersion: 1, attempts: 0, modelCalls: 0, tokens: 0, costMicros: 0, elapsedMs: 0 }),
      } });
      await tx.jobIndexRequest.create({ data: { ownerId, idempotencyKey, requestHash: hash, taskId } });
      await tx.jobIndexTarget.upsert({ where: { ownerId_jobVersionId: { ownerId, jobVersionId: id } },
        create: { ownerId, jobVersionId: id, taskId, embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion },
        update: { taskId, embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion } });
      await tx.jobVersion.update({ where: { ownerId, id }, data: { indexStatus: 'PENDING' } });
      await tx.outboxEvent.create({ data: { eventId, ownerId, aggregateType: 'JobIndexTask', aggregateId: taskId,
        eventType: 'job.index.requested.v1', payloadVersion: 1,
        payload: taskDispatchSchema.parse({ schemaVersion: 1, messageId: eventId, taskType: 'job-index', taskId,
          dispatchGeneration: 1, occurredAt: new Date().toISOString() }),
      } });
      return { jobVersionId: id, taskId, created: true };
    });
  }
}
