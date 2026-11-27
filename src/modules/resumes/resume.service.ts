import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ResumeRepository } from '../../infrastructure/storage/resume.repository.js';
import { IDENTITY } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import type { StoragePort, StagedFile } from '../storage/storage.port.js';
import type { ParserPort } from '../parsing/contracts.js';
import { extractedDocument } from './evidence.js';
import { documentMimeSchema, resumeListResponseSchema, resumeVersionResponseSchema } from '../../contracts/resumes.js';
import { RequestValidationError } from '../../infrastructure/http/zod-validation.pipe.js';

export const RESUME_STORAGE = Symbol('RESUME_STORAGE'), RESUME_PARSER = Symbol('RESUME_PARSER');
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
@Injectable()
export class ResumeService {
  constructor(private readonly repository: ResumeRepository, @Inject(IDENTITY) private readonly identity: IdentityPort,
    @Inject(RESUME_STORAGE) readonly storage: StoragePort, @Inject(RESUME_PARSER) private readonly parser: ParserPort) {}

  async upload(key: string, file: StagedFile, filename: string, mime: string, signal: AbortSignal) {
    const ownerId = await this.identity.getOwnerId();
    try {
      signal.throwIfAborted();
      const prior = await this.repository.replay(ownerId, key, file.sha256);
      if (prior) return await this.detail(ownerId, prior.resumeId, prior.id);
      const bytes = await this.storage.readStaged(file);
      const parsed = await this.parser.parse(bytes, filename, mime, signal);
      const resumeId = randomUUID(), resumeVersionId = randomUUID();
      const document = extractedDocument(resumeVersionId, file.sha256, parsed);
      signal.throwIfAborted(); await this.storage.commit(file); signal.throwIfAborted();
      const result = await this.repository.register({ ownerId, idempotencyKey: key, resumeId, resumeVersionId,
        file: { id: randomUUID(), ownerId, storageKey: file.storageKey, sha256: file.sha256,
          mime: documentMimeSchema.parse(mime), size: file.size, createdAt: new Date().toISOString() }, blocks: document.blocks, document,
      }, signal);
      const saved = await this.repository.findVersion(ownerId, result.resumeVersionId);
      if (!saved) throw new Error('RESUME_COMMIT_UNCONFIRMED');
      return await this.detail(ownerId, saved.resumeId, saved.id);
    } finally {
      // Unknown DB result/query failure retains the manifest; never delete a referenced committed file.
      await this.storage.compensate(file, this.repository).catch(() => {throw new Error('UPLOAD_CLEANUP_UNCONFIRMED');});
    }
  }

  async get(resumeId: string, versionId: string) { return this.detail(await this.identity.getOwnerId(), resumeId, versionId); }
  private async detail(ownerId: string, resumeId: string, versionId: string) {
    const row = await this.repository.findVersion(ownerId, versionId), document = await this.repository.document(ownerId, versionId);
    if (!row || row.resumeId !== resumeId || !document) throw new NotFoundException();
    return resumeVersionResponseSchema.parse({ resumeId: row.resumeId, resumeVersionId: row.id, version: row.version,
      file: { sha256: row.fileHash, mime: row.fileAsset.mime, size: row.fileAsset.size }, extractedDocument: document, createdAt: row.createdAt.toISOString() });
  }
  async list(limit: number, cursor?: string) {
    let decoded: z.infer<typeof cursorSchema> | undefined;
    if (cursor) {
      try { decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown); }
      catch { throw new RequestValidationError(); }
    }
    const rows = await this.repository.list(await this.identity.getOwnerId(), limit, decoded), page = rows.slice(0, limit), last = page.at(-1);
    return resumeListResponseSchema.parse({ items: page.map(row => ({ id: row.id, latestVersionId: row.versions[0]?.id,
      version: row.versions[0]?.version, createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() })).toString('base64url') : null });
  }
}
