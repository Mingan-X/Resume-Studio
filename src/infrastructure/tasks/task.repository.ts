import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { DatabaseService } from '../database/database.service.js';
import {
  analysisInputSnapshotSchema, jobIndexInputSnapshotSchema, budgetUsageSchema,
  idempotencyKeySchema, taskDispatchSchema,
} from '../../contracts/tasks.js';
import type { AnalysisInputSnapshot, JobIndexInputSnapshot } from '../../contracts/tasks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { IdempotencyConflictError } from '../../modules/tasks/task-errors.js';

type Creation =
  | { taskType: 'analysis'; snapshot: AnalysisInputSnapshot }
  | { taskType: 'job-index'; snapshot: JobIndexInputSnapshot };

@Injectable()
export class TaskRepository {
  constructor(private readonly database: DatabaseService) {}

  createAnalysis(key: string, input: AnalysisInputSnapshot) {
    return this.create(idempotencyKeySchema.parse(key), {
      taskType: 'analysis', snapshot: analysisInputSnapshotSchema.parse(input),
    });
  }

  createJobIndex(key: string, input: JobIndexInputSnapshot) {
    return this.create(idempotencyKeySchema.parse(key), {
      taskType: 'job-index', snapshot: jobIndexInputSnapshotSchema.parse(input),
    });
  }

  private async create(key: string, request: Creation) {
    const { ownerId } = request.snapshot;
    const hash = requestHash(request);
    const where = { ownerId_idempotencyKey: { ownerId, idempotencyKey: key } };
    const select = { id: true, requestHash: true, inputSnapshot: true } as const;
    const find = (db: Prisma.TransactionClient) => request.taskType === 'analysis'
      ? db.analysisTask.findUnique({ where, select })
      : db.jobIndexTask.findUnique({ where, select });
    const replay = (existing: { id: string; requestHash: string; inputSnapshot: unknown }) => {
      // JSON from persistence is untrusted too. No request values are echoed on conflict.
      const snapshot = request.taskType === 'analysis'
        ? analysisInputSnapshotSchema.parse(existing.inputSnapshot)
        : jobIndexInputSnapshotSchema.parse(existing.inputSnapshot);
      if (existing.requestHash !== hash) throw new IdempotencyConflictError();
      if (snapshot.ownerId !== ownerId) throw new Error('Task snapshot ownership mismatch.');
      return { taskId: existing.id, taskType: request.taskType };
    };

    try {
      return await this.database.client.$transaction(async tx => {
        const existing = await find(tx);
        if (existing) return replay(existing);
        const taskId = randomUUID();
        const eventId = randomUUID();
        const common = {
          id: taskId, ownerId, idempotencyKey: key, requestHash: hash,
          budgetUsage: budgetUsageSchema.parse({
            schemaVersion: 1, attempts: 0, modelCalls: 0, tokens: 0, costMicros: 0, elapsedMs: 0,
          }),
        };
        if (request.taskType === 'analysis') {
          await tx.analysisTask.create({ data: {
            ...common, resumeVersionId: request.snapshot.resumeVersionId,
            activeGraphThreadId: taskId, inputSnapshot: request.snapshot,
          } });
        } else {
          await tx.jobIndexTask.create({ data: {
            ...common, jobVersionId: request.snapshot.jobVersionId,
            embeddingVersion: request.snapshot.embeddingVersion, indexVersion: request.snapshot.indexVersion,
            inputSnapshot: request.snapshot,
          } });
        }
        await tx.outboxEvent.create({ data: {
          eventId, ownerId,
          aggregateType: request.taskType === 'analysis' ? 'AnalysisTask' : 'JobIndexTask',
          aggregateId: taskId,
          eventType: request.taskType === 'analysis' ? 'analysis.requested.v1' : 'job.index.requested.v1',
          payloadVersion: 1,
          payload: taskDispatchSchema.parse({
            schemaVersion: 1, messageId: eventId, taskType: request.taskType, taskId,
            dispatchGeneration: 1, occurredAt: new Date().toISOString(),
          }),
        } });
        return { taskId, taskType: request.taskType };
      });
    } catch (error) {
      // The losing transaction is already rolled back. Read the committed winner in a new snapshot.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await find(this.database.client);
        if (winner) return replay(winner);
      }
      throw error;
    }
  }
}
