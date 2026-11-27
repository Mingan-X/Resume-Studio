import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { DatabaseService } from '../database/database.service.js';
import { jobSchema, jobVersionSchema, versionNameSchema } from '../../contracts/jobs.js';
import type { JobVersion } from '../../contracts/jobs.js';
import { rubricVersionSchema } from '../../contracts/rubric.js';
import { validateJobRequirements } from '../../modules/jobs/evidence.js';
import { textHash } from '../../modules/resumes/evidence.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { randomUUID } from 'node:crypto';
import { editDraft } from '../../modules/jobs/drafts.js';

function validateVersion(ownerId: string, raw: unknown) {
  const value = jobVersionSchema.parse(raw);
  if (value.ownerId !== z.uuid().parse(ownerId)) throw new Error('JOB_OWNER_MISMATCH');
  if (value.document.blocks.some(block => textHash(block.text) !== block.textHash)) throw new Error('INVALID_JD_HASH');
  validateJobRequirements(ownerId, value.ownerId, value.document, value.requirements);
  return value;
}
export async function insertDraftVersion(tx: Prisma.TransactionClient, ownerId: string, raw: unknown) {
  const value = validateVersion(ownerId, raw);
  if (value.status !== 'DRAFT') throw new Error('DRAFT_REQUIRED');
  await tx.jobVersion.create({ data: { id: value.id, ownerId, jobId: value.jobId, version: value.version,
    title: value.title, city: value.city, level: value.level, skills: value.skills, document: value.document,
    dimensionWeights: value.dimensionWeights, hardRequirementsConfirmed: value.hardRequirementsConfirmed,
    weightsConfirmed: value.weightsConfirmed, createdAt: new Date(value.createdAt),
  } });
  await tx.jobRequirement.createMany({ data: value.requirements.map((requirement, ordinal) => ({
    ownerId, jobVersionId: value.id, stableId: requirement.stableId, ordinal, requirement,
  })) });
  return value;
}
export async function readJobVersion(tx: Prisma.TransactionClient, owner: string, id: string): Promise<JobVersion | null> {
  const ownerId = z.uuid().parse(owner), versionId = z.uuid().parse(id);
  const row = await tx.jobVersion.findFirst({ where: { ownerId, id: versionId },
    include: { requirements: { where: { ownerId }, orderBy: { ordinal: 'asc' } } } });
  if (!row) return null;
  return validateVersion(ownerId, { ...row, schemaVersion: 1,
    createdAt: row.createdAt.toISOString(), publishedAt: row.publishedAt?.toISOString() ?? null,
    requirements: row.requirements.map((item, ordinal) => {
      if (item.ordinal !== ordinal) throw new Error('INVALID_REQUIREMENT_ORDER');
      return item.requirement;
    }),
  });
}

@Injectable()
export class JobRepository {
  constructor(private readonly database: DatabaseService) {}

  async createDraft(owner: string, raw: unknown) {
    const ownerId = z.uuid().parse(owner), value = validateVersion(ownerId, raw);
    if (value.status !== 'DRAFT' || value.version !== 1) throw new Error('INITIAL_DRAFT_REQUIRED');
    return this.database.client.$transaction(async tx => {
      await tx.job.create({ data: { id: value.jobId, ownerId, createdAt: new Date(value.createdAt) } });
      return insertDraftVersion(tx, ownerId, value);
    });
  }
  async findJob(owner: string, id: string) {
    const row = await this.database.client.job.findFirst({ where: { ownerId: z.uuid().parse(owner), id: z.uuid().parse(id) } });
    return row ? jobSchema.parse({ ...row, createdAt: row.createdAt.toISOString() }) : null;
  }
  async findVersion(owner: string, id: string) {
    return this.database.client.$transaction(tx => readJobVersion(tx, owner, id), { isolationLevel: 'RepeatableRead' });
  }
  async editDraft(owner: string, id: string, edit: unknown) {
    const ownerId = z.uuid().parse(owner), versionId = z.uuid().parse(id);
    return this.database.client.$transaction(async tx => {
      const identity = await tx.jobVersion.findFirst({ where: { ownerId, id: versionId }, select: { jobId: true } });
      if (!identity) throw new Error('JOB_NOT_FOUND');
      // Lock the job before its versions so concurrent edits of published versions allocate unique numbers.
      await tx.$queryRaw`SELECT id FROM job WHERE owner_id=${ownerId}::uuid AND id=${identity.jobId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM job_version WHERE owner_id=${ownerId}::uuid AND id=${versionId}::uuid FOR UPDATE`;
      const original = await readJobVersion(tx, ownerId, versionId);
      if (!original) throw new Error('JOB_NOT_FOUND');
      const latest = await tx.jobVersion.findFirstOrThrow({ where: { ownerId, jobId: identity.jobId }, orderBy: { version: 'desc' }, select: { version: true } });
      const updated = editDraft(original, edit, original.status === 'PUBLISHED'
        ? { id: randomUUID(), version: latest.version + 1, createdAt: new Date().toISOString() }
        : { id: original.id, version: original.version, createdAt: original.createdAt });
      if (original.status === 'PUBLISHED') return insertDraftVersion(tx, ownerId, updated);
      await tx.jobVersion.update({ where: { ownerId, id: versionId }, data: {
        title: updated.title, city: updated.city, level: updated.level, skills: updated.skills,
        document: updated.document, dimensionWeights: updated.dimensionWeights,
        hardRequirementsConfirmed: false, weightsConfirmed: false,
      } });
      await tx.jobRequirement.deleteMany({ where: { ownerId, jobVersionId: versionId } });
      await tx.jobRequirement.createMany({ data: updated.requirements.map((requirement, ordinal) => ({
        ownerId, jobVersionId: versionId, stableId: requirement.stableId, ordinal, requirement,
      })) });
      return updated;
    });
  }
  async insertRubric(owner: string, raw: unknown) {
    const ownerId = z.uuid().parse(owner), content = rubricVersionSchema.parse(raw), contentHash = requestHash(content);
    await this.database.client.rubricVersion.create({ data: { ownerId, version: content.version, content, contentHash } });
    return { version: content.version, contentHash };
  }
  async importRubric(owner: string, raw: unknown) {
    const ownerId = z.uuid().parse(owner), content = rubricVersionSchema.parse(raw), contentHash = requestHash(content);
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, content.version])}, 23))::text`;
      const prior = await tx.rubricVersion.findFirst({ where: { ownerId, version: content.version } });
      if (prior) {
        const parsed = rubricVersionSchema.parse(prior.content);
        if (requestHash(parsed) !== prior.contentHash) throw new Error('INVALID_RUBRIC_HASH');
        if (prior.contentHash !== contentHash) throw new Error('RUBRIC_VERSION_CONFLICT');
        return { version: content.version, contentHash, replay: true };
      }
      await tx.rubricVersion.create({ data: { ownerId, version: content.version, content, contentHash } });
      return { version: content.version, contentHash, replay: false };
    });
  }
  async findRubric(owner: string, version: string) {
    const ownerId = z.uuid().parse(owner);
    const row = await this.database.client.rubricVersion.findFirst({ where: { ownerId, version: versionNameSchema.parse(version) } });
    if (!row) return null;
    const content = rubricVersionSchema.parse(row.content);
    if (content.version !== row.version || requestHash(content) !== row.contentHash) throw new Error('INVALID_RUBRIC_HASH');
    return { content, contentHash: row.contentHash };
  }
  async latestVersion(owner: string, job: string) {
    const ownerId = z.uuid().parse(owner), jobId = z.uuid().parse(job);
    return this.database.client.$transaction(async tx => {
      const row = await tx.jobVersion.findFirst({ where: { ownerId, jobId }, orderBy: { version: 'desc' }, select: { id: true } });
      return row ? readJobVersion(tx, ownerId, row.id) : null;
    }, { isolationLevel: 'RepeatableRead' });
  }
  async list(owner: string, limit: number, cursor?: { createdAt: string; id: string }) {
    const ownerId = z.uuid().parse(owner);
    return this.database.client.$transaction(async tx => {
      const rows = await tx.job.findMany({ where: { ownerId, ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } });
      const result = [];
      for (const row of rows) {
        const versionId = row.versions[0]?.id, value = versionId ? await readJobVersion(tx, ownerId, versionId) : null;
        if (!value) throw new Error('JOB_VERSION_MISSING');
        result.push({ id: row.id, createdAt: row.createdAt.toISOString(), latestVersion: value });
      }
      return result;
    }, { isolationLevel: 'RepeatableRead' });
  }
}
