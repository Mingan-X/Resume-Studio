import { z } from 'zod';
import type { DatabaseService } from '../database/database.service.js';
import { keywordCandidateSchema, keywordRecallConfigSchema, recallQuerySchema } from '../../contracts/recall.js';
import { JobCorpusRepository } from './corpus.repository.js';
import { normalizeSkills } from '../../modules/recall/skills.js';

const rowSchema = z.object({ jobId: z.uuid(), jobVersionId: z.uuid(), matchedSkills: z.array(z.string()).min(1) }).strict();
export class KeywordRecallRepository {
  constructor(private readonly database: DatabaseService) {}

  async recall(owner: string, rawQuery: unknown, rawConfig: unknown = { version: 'keyword-overlap-v1' }) {
    const ownerId = z.uuid().parse(owner), query = recallQuerySchema.parse(rawQuery), config = keywordRecallConfigSchema.parse(rawConfig);
    const corpus = await new JobCorpusRepository(this.database).load(ownerId, query.corpusVersion);
    if (!corpus) throw new Error('CORPUS_NOT_FOUND');
    const skills = normalizeSkills(query.skills, corpus.manifest.dictionary).skills;
    const result = z.array(rowSchema).parse(await this.database.client.$queryRaw`
      SELECT v.job_id AS "jobId", v.id AS "jobVersionId", hits.skills AS "matchedSkills"
      FROM job_corpus_version c
      CROSS JOIN LATERAL jsonb_array_elements(c.manifest->'members') member
      JOIN job_version v ON v.id=(member->>'jobVersionId')::uuid AND v.owner_id=c.owner_id
      CROSS JOIN LATERAL (
        SELECT array_agg(DISTINCT skill COLLATE "C" ORDER BY skill COLLATE "C") AS skills
        FROM jsonb_array_elements_text(member->'skills') AS s(skill)
        WHERE skill=ANY(${skills}::text[])
      ) hits
      WHERE c.owner_id=${ownerId}::uuid AND c.version=${query.corpusVersion}
        AND c.visibility='private' AND c.content_hash=${corpus.contentHash}
        AND v.status='PUBLISHED' AND v.content_hash=member->>'contentHash'
        AND (${query.city}::text IS NULL OR v.city=${query.city}::text)
        AND cardinality(hits.skills)>0
      ORDER BY cardinality(hits.skills) DESC, v.job_id ASC, v.id ASC
      LIMIT ${config.limit}
    `);
    return { corpusVersion: query.corpusVersion, corpusHash: corpus.contentHash, config,
      dictionaryVersion: corpus.manifest.dictionary.version,
      candidates: result.map((row, index) => keywordCandidateSchema.parse({ ...row, source: 'keyword', rank: index + 1 })) };
  }
}
