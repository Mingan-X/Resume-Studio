import { z } from 'zod';
import type { DatabaseService } from '../database/database.service.js';
import { corpusManifestSchema, skillDictionarySchema } from '../../contracts/job-corpus.js';
import { versionNameSchema } from '../../contracts/jobs.js';
import { normalizeSkills } from '../../modules/recall/skills.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

export class JobCorpusRepository {
  constructor(private readonly database: DatabaseService) {}

  async freeze(owner: string, version: string, rawIds: unknown, rawDictionary: unknown) {
    const ownerId = z.uuid().parse(owner), name = versionNameSchema.parse(version);
    const ids = z.array(z.uuid()).min(1).max(10_000).parse(rawIds).sort();
    if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_CORPUS_MEMBER');
    const dictionary = skillDictionarySchema.parse(rawDictionary);
    normalizeSkills([], dictionary);
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, name])}, 24))::text`;
      const rows = await tx.jobVersion.findMany({ where: { ownerId, id: { in: ids }, status: 'PUBLISHED' },
        select: { id: true, contentHash: true, skills: true }, orderBy: { id: 'asc' } });
      if (rows.length !== ids.length) throw new Error('CORPUS_MEMBER_NOT_VISIBLE_OR_PUBLISHED');
      const manifest = corpusManifestSchema.parse({ schemaVersion: 1, ownerId, version: name, visibility: 'private', dictionary,
        members: rows.map(row => ({ jobVersionId: row.id, contentHash: row.contentHash, skills: normalizeSkills(row.skills, dictionary).skills })) });
      const contentHash = requestHash(manifest);
      const prior = await tx.jobCorpusVersion.findUnique({ where: { ownerId_version: { ownerId, version: name } } });
      if (prior) {
        if (requestHash(corpusManifestSchema.parse(prior.manifest)) !== prior.contentHash) throw new Error('CORPUS_HASH_INVALID');
        if (prior.contentHash !== contentHash) throw new Error('CORPUS_VERSION_CONFLICT');
      } else await tx.jobCorpusVersion.create({ data: { ownerId, version: name, visibility: 'private', contentHash, manifest } });
      return { manifest, contentHash, replay: !!prior };
    });
  }

  async load(owner: string, version: string) {
    const ownerId = z.uuid().parse(owner), name = versionNameSchema.parse(version);
    const row = await this.database.client.jobCorpusVersion.findUnique({ where: { ownerId_version: { ownerId, version: name } } });
    if (!row) return null;
    const manifest = corpusManifestSchema.parse(row.manifest);
    if (manifest.ownerId !== ownerId || manifest.version !== name || manifest.visibility !== row.visibility
      || requestHash(manifest) !== row.contentHash) throw new Error('CORPUS_HASH_INVALID');
    return { manifest, contentHash: row.contentHash };
  }
}
