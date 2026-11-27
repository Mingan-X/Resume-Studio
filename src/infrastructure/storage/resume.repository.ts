import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { fileAssetSchema } from '../../contracts/resumes.js';
import { evidenceBlockSchema, extractedDocumentSchema } from '../../contracts/evidence.js';
import { textHash, validateEvidence } from '../../modules/resumes/evidence.js';
import { IdempotencyConflictError } from '../../modules/tasks/task-errors.js';
import type { StorageReferencePort } from '../../modules/storage/storage.port.js';

export const registerResumeSchema = z.object({
  ownerId: z.uuid(), idempotencyKey: z.uuid(), resumeId: z.uuid(), resumeVersionId: z.uuid(),
  file: fileAssetSchema, blocks: z.array(evidenceBlockSchema), document: extractedDocumentSchema.optional(),
}).strict().refine(value => value.ownerId === value.file.ownerId)
  .refine(value => value.blocks.every((block, index) => block.ordinal === index)
    && new Set(value.blocks.map(block => block.id)).size === value.blocks.length)
  .refine(value => value.blocks.every(block => textHash(block.text) === block.textHash))
  .refine(value => !value.document || value.document.sourceVersionId === value.resumeVersionId
    && value.document.fileHash === value.file.sha256 && JSON.stringify(value.document.blocks) === JSON.stringify(value.blocks));

@Injectable()
export class ResumeRepository implements StorageReferencePort {
  constructor(private readonly database: DatabaseService) {}

  async register(input: unknown, signal?: AbortSignal): Promise<{ resumeVersionId: string; replay: boolean }> {
    const value = registerResumeSchema.parse(input);
    return this.database.client.$transaction(async tx => {
      signal?.throwIfAborted();
      // Serializes one owner/key even before the idempotency row exists.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([value.ownerId, value.idempotencyKey])}, 21))::text`;
      const prior = await tx.resumeUpload.findUnique({ where: { ownerId_idempotencyKey: {
        ownerId: value.ownerId, idempotencyKey: value.idempotencyKey,
      } } });
      if (prior) {
        if (prior.fileHash !== value.file.sha256) throw new IdempotencyConflictError();
        return { resumeVersionId: prior.resumeVersionId, replay: true };
      }
      await tx.fileAsset.create({ data: { ...value.file, createdAt: new Date(value.file.createdAt) } });
      await tx.resume.create({ data: { id: value.resumeId, ownerId: value.ownerId } });
      await tx.resumeVersion.create({ data: { id: value.resumeVersionId, ownerId: value.ownerId,
        resumeId: value.resumeId, version: 1, fileAssetId: value.file.id, fileHash: value.file.sha256,createdAt:new Date(value.file.createdAt) } });
      await tx.evidenceBlock.createMany({ data: value.blocks.map(block => ({
        ...block, ownerId: value.ownerId, sourceVersionId: value.resumeVersionId,
      })) });
      if (value.document) await tx.extractedDocument.create({ data: { ownerId: value.ownerId,
        sourceVersionId: value.resumeVersionId, fileHash: value.file.sha256, document: value.document } });
      await tx.resumeUpload.create({ data: { ownerId: value.ownerId, idempotencyKey: value.idempotencyKey,
        fileHash: value.file.sha256, resumeVersionId: value.resumeVersionId } });
      signal?.throwIfAborted();
      return { resumeVersionId: value.resumeVersionId, replay: false };
    });
  }

  async findVersion(ownerId: string, versionId: string) {
    const owner = z.uuid().parse(ownerId), id = z.uuid().parse(versionId);
    const version = await this.database.client.resumeVersion.findUnique({ where: { ownerId_id: { ownerId: owner, id } },
      include: { fileAsset: true, blocks: { orderBy: { ordinal: 'asc' } } } });
    if (!version) return null;
    return { ...version, blocks: version.blocks.map(block => evidenceBlockSchema.parse({
      id: block.id, ordinal: block.ordinal, text: block.text, textHash: block.textHash, location: block.location,
    })) };
  }

  async isReferenced(storageKey: string): Promise<boolean> {
    const key = z.uuid().parse(storageKey);
    // Global reference check is internal GC only, never an owner-facing read API.
    return await this.database.client.fileAsset.count({ where: { storageKey: key } }) !== 0;
  }

  async document(ownerId: string, versionId: string) {
    const row = await this.database.client.extractedDocument.findFirst({ where: {
      ownerId: z.uuid().parse(ownerId), sourceVersionId: z.uuid().parse(versionId),
    } });
    if (!row) return null;
    const document = extractedDocumentSchema.parse(row.document);
    if (document.sourceVersionId !== row.sourceVersionId || document.fileHash !== row.fileHash
      || document.blocks.some(block => textHash(block.text) !== block.textHash)) throw new Error('INVALID_DOCUMENT');
    return document;
  }

  async validateReference(ownerId: string, versionId: string, ref: unknown) {
    const document = await this.document(ownerId, versionId);
    if (!document) throw new Error('INVALID_EVIDENCE');
    return validateEvidence(ownerId, ownerId, document, ref);
  }

  async replay(ownerId: string, key: string, fileHash: string) {
    const prior = await this.database.client.resumeUpload.findUnique({ where: { ownerId_idempotencyKey: {
      ownerId: z.uuid().parse(ownerId), idempotencyKey: z.uuid().parse(key),
    } } });
    if (!prior) return null;
    if (prior.fileHash !== fileHash) throw new IdempotencyConflictError();
    return this.findVersion(ownerId, prior.resumeVersionId);
  }

  async list(ownerId: string, limit: number, cursor?: { createdAt: string; id: string }) {
    return this.database.client.resume.findMany({ where: { ownerId: z.uuid().parse(ownerId),
      ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
  }
}
