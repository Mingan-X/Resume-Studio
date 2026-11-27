import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { TransactionDatabase } from '../database/transaction-port.js';
import { textHash } from '../../modules/resumes/evidence.js';
import { scoringPolicySchema } from '../../contracts/scoring.js';
import { createAnalysisRequestSchema } from '../../contracts/analyses.js';
import { analysisConfigurationSchema, realAnalysisInputSchema, analysisInputSnapshotSchema,
  idempotencyKeySchema, budgetUsageSchema, taskDispatchSchema } from '../../contracts/tasks.js';
import { corpusManifestSchema } from '../../contracts/job-corpus.js';
import { rubricVersionSchema } from '../../contracts/rubric.js';
import { extractedDocumentSchema } from '../../contracts/evidence.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { IdempotencyConflictError, TaskNotFoundError, AnalysisInputStateError } from '../../modules/tasks/task-errors.js';

@Injectable()
export class AnalysisRepository {
  constructor(@Inject(DatabaseService) private readonly database: TransactionDatabase) {}

  async create(owner: string, rawKey: unknown, rawRequest: unknown, rawConfiguration: unknown, allowSynthetic = false) {
    const ownerId = z.uuid().parse(owner), key = idempotencyKeySchema.parse(rawKey);
    const request = createAnalysisRequestSchema.parse(rawRequest);
    const hash = requestHash({ taskType: 'analysis', kind: 'analysis', ownerId, request });
    try { return await this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, key])}, 24))::text`;
      const prior = await tx.analysisTask.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey: key } } });
      if (prior) {
        const snapshot = analysisInputSnapshotSchema.parse(prior.inputSnapshot);
        if (prior.requestHash !== hash || snapshot.kind !== 'analysis' || snapshot.ownerId !== ownerId) throw new IdempotencyConflictError();
        return prior.id;
      }
      if (!rawConfiguration) throw new Error('ANALYSIS_CONFIG_UNAVAILABLE');
      const configuration = analysisConfigurationSchema.parse(rawConfiguration), configurationHash = requestHash(configuration);
      if (!allowSynthetic && configuration.indexTarget.provenance !== 'bailian') throw new Error('ANALYSIS_CONFIG_UNAVAILABLE');
      const documentRow = await tx.extractedDocument.findFirst({ where: { ownerId, sourceVersionId: request.resumeVersionId } });
      const corpusRow = await tx.jobCorpusVersion.findUnique({ where: { ownerId_version: { ownerId, version: request.jobCorpusVersionId } } });
      const rubricRow = await tx.rubricVersion.findUnique({ where: { ownerId_version: { ownerId, version: configuration.rubricVersion } } });
      const policyRow = await tx.scoringPolicy.findUnique({ where: { ownerId_version: { ownerId, version: configuration.scoringVersion } } });
      if (!documentRow || !corpusRow || !rubricRow || !policyRow) throw new TaskNotFoundError();
      const policy = scoringPolicySchema.parse(policyRow.content);
      if (policy.version !== configuration.scoringVersion || requestHash(policy) !== policyRow.contentHash) throw new AnalysisInputStateError();
      const document = extractedDocumentSchema.parse(documentRow.document), corpus = corpusManifestSchema.parse(corpusRow.manifest);
      const rubric = rubricVersionSchema.parse(rubricRow.content);
      if (document.sourceVersionId !== request.resumeVersionId || document.fileHash !== documentRow.fileHash
        || document.blocks.some(block => textHash(block.text) !== block.textHash)
        || corpus.ownerId !== ownerId || corpus.version !== request.jobCorpusVersionId || requestHash(corpus) !== corpusRow.contentHash
        || rubric.version !== configuration.rubricVersion || requestHash(rubric) !== rubricRow.contentHash
        || (!allowSynthetic && rubric.provenance === 'SYNTHETIC')) throw new AnalysisInputStateError();
      // One immutable configuration per owner/version, shared by all subsequent tasks.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, configuration.configurationVersion])}, 25))::text`;
      const configRow = await tx.analysisConfiguration.findUnique({ where: { ownerId_version: { ownerId, version: configuration.configurationVersion } } });
      if (configRow) {
        const saved = analysisConfigurationSchema.parse(configRow.content);
        if (requestHash(saved) !== configRow.contentHash || configRow.contentHash !== configurationHash) throw new AnalysisInputStateError();
      } else await tx.analysisConfiguration.create({ data: { ownerId, version: configuration.configurationVersion, content: configuration, contentHash: configurationHash } });
      const snapshot = realAnalysisInputSchema.parse({ ...configuration, kind: 'analysis', ownerId, ...request,
        configurationHash, resumeFileHash: document.fileHash, corpusHash: corpusRow.contentHash, rubricHash: rubricRow.contentHash, scoringPolicyHash: policyRow.contentHash });
      const taskId = randomUUID(), eventId = randomUUID();
      await tx.analysisTask.create({ data: { id: taskId, ownerId, resumeVersionId: request.resumeVersionId,
        realResumeVersionId: request.resumeVersionId, corpusVersion: request.jobCorpusVersionId,
        rubricVersion: configuration.rubricVersion, configurationVersion: configuration.configurationVersion,
        scoringPolicyVersion: configuration.scoringVersion,
        activeGraphThreadId: taskId, inputSnapshot: snapshot, idempotencyKey: key, requestHash: hash,
        budgetUsage: budgetUsageSchema.parse({ schemaVersion: 1, attempts: 0, modelCalls: 0, tokens: 0, costMicros: 0, elapsedMs: 0 }),
      } });
      await tx.outboxEvent.create({ data: { eventId, ownerId, aggregateType: 'AnalysisTask', aggregateId: taskId,
        eventType: 'analysis.requested.v1', payloadVersion: 1,
        payload: taskDispatchSchema.parse({ schemaVersion: 1, messageId: eventId, taskType: 'analysis', taskId,
          dispatchGeneration: 1, occurredAt: new Date().toISOString() }),
      } });
      return taskId;
    }); } catch (error) {
      // Synthetic creation predates the advisory lock. Its concurrent unique-key win is still a conflict.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const prior = await this.database.client.$transaction(tx => tx.analysisTask.findUnique({
          where: { ownerId_idempotencyKey: { ownerId, idempotencyKey: key } },
        }));
        if (prior) {
          const snapshot = analysisInputSnapshotSchema.parse(prior.inputSnapshot);
          if (prior.requestHash !== hash || snapshot.kind !== 'analysis' || snapshot.ownerId !== ownerId) throw new IdempotencyConflictError();
          return prior.id;
        }
      }
      throw error;
    }
  }
}
