import { Injectable, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { IDENTITY } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { JobRepository } from '../../infrastructure/jobs/job.repository.js';
import { JobDraftService } from './job-draft.service.js';
import { JobPublicationService } from './job-publication.service.js';
import { JobExtractionService } from './job-extraction.service.js';
import { jobListResponseSchema, jobVersionResponseSchema } from '../../contracts/job-api.js';
import type { JobVersion } from '../../contracts/jobs.js';
import { RequestValidationError } from '../../infrastructure/http/zod-validation.pipe.js';

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
function response(value: JobVersion) {
  const { ownerId: _owner, ...publicValue } = value;
  void _owner;
  return jobVersionResponseSchema.parse(publicValue);
}
@Injectable()
export class JobApiService {
  constructor(@Inject(IDENTITY) private readonly identity: IdentityPort, private readonly jobs: JobRepository,
    private readonly drafts: JobDraftService, private readonly publications: JobPublicationService,
    private readonly extraction: JobExtractionService) {}
  async create(input: unknown) { return response(await this.drafts.create(input)); }
  private async authorized(jobId: string, versionId: string) {
    const value = await this.jobs.findVersion(await this.identity.getOwnerId(), versionId);
    if (!value || value.jobId !== jobId) throw new NotFoundException(); return value;
  }
  async version(jobId: string, versionId: string) { return response(await this.authorized(jobId, versionId)); }
  async get(jobId: string) {
    const ownerId = await this.identity.getOwnerId(), value = await this.jobs.latestVersion(ownerId, jobId);
    if (!value) throw new NotFoundException(); return response(value);
  }
  async edit(jobId: string, versionId: string, input: unknown) {
    await this.authorized(jobId, versionId); return response(await this.drafts.edit(versionId, input));
  }
  async confirm(jobId: string, versionId: string, input: unknown) {
    await this.authorized(jobId, versionId); return response(await this.publications.confirm(versionId, input));
  }
  async publish(jobId: string, versionId: string, key: string) {
    await this.authorized(jobId, versionId); return this.publications.publish(versionId, key);
  }
  async suggest(jobId: string, versionId: string, signal: AbortSignal) {
    await this.authorized(jobId, versionId); return this.extraction.suggest(versionId, signal);
  }
  async list(limit: number, cursor?: string) {
    let decoded: z.infer<typeof cursorSchema> | undefined;
    if (cursor) try { decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown); }
    catch { throw new RequestValidationError(); }
    const rows = await this.jobs.list(await this.identity.getOwnerId(), limit, decoded), page = rows.slice(0, limit), last = page.at(-1);
    return jobListResponseSchema.parse({ items: page.map(row => ({ id: row.id, createdAt: row.createdAt, latestVersion: response(row.latestVersion) })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt })).toString('base64url') : null });
  }
}
