import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { fileAssetSchema } from '../../contracts/resumes.js';
import { evidenceBlockSchema } from '../../contracts/evidence.js';
import { IdempotencyConflictError } from '../../modules/tasks/task-errors.js';
import type { StorageReferencePort } from '../../modules/storage/storage.port.js';

export const registerResumeSchema = z.object({
  ownerId: z.uuid(), idempotencyKey: z.uuid(), resumeId: z.uuid(), resumeVersionId: z.uuid(),
  file: fileAssetSchema, blocks: z.array(evidenceBlockSchema),
}).strict().refine(value => value.ownerId === value.file.ownerId)
  .refine(value => value.blocks.every((block, index) => block.ordinal === index)
    && new Set(value.blocks.map(block => block.id)).size === value.blocks.length);

@Injectable()
export class ResumeRepository implements StorageReferencePort {
  constructor(private readonly database: DatabaseService) {}

  async register(input: unknown): Promise<{ resumeVersionId: string; replay: boolean }> {
    const value = registerResumeSchema.parse(input);
    return this.database.client.$transaction(async tx => {
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
        resumeId: value.resumeId, version: 1, fileAssetId: value.file.id, fileHash: value.file.sha256 } });
      await tx.evidenceBlock.createMany({ data: value.blocks.map(block => ({
        ...block, ownerId: value.ownerId, sourceVersionId: value.resumeVersionId,
      })) });
      await tx.resumeUpload.create({ data: { ownerId: value.ownerId, idempotencyKey: value.idempotencyKey,
        fileHash: value.file.sha256, resumeVersionId: value.resumeVersionId } });
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
}
