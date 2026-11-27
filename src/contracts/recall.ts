import { z } from 'zod';
import { versionNameSchema } from './jobs.js';
import { indexCollectionSchema } from './job-index.js';

export const recallQuerySchema = z.object({ schemaVersion: z.literal(1), corpusVersion: versionNameSchema,
  skills: z.array(z.string().trim().min(1).max(128)).max(100), summary: z.string().max(20_000),
  // Only an explicit user-selected city filters jobs; missing resume city is not a constraint.
  city: z.string().trim().min(1).max(128).nullable().default(null),
}).strict();
export const keywordRecallConfigSchema = z.object({ version: z.literal('keyword-overlap-v1'),
  limit: z.int().min(1).max(100).default(50),
}).strict();
export const keywordCandidateSchema = z.object({ jobId: z.uuid(), jobVersionId: z.uuid(), source: z.literal('keyword'),
  rank: z.int().positive(), matchedSkills: z.array(z.string()).min(1),
}).strict();
export type RecallQuery = z.infer<typeof recallQuerySchema>;
export type KeywordRecallConfig = z.infer<typeof keywordRecallConfigSchema>;

export const recallConfigSchema = z.object({ version: z.literal('hybrid-rrf-v1'),
  keywordLimit: z.int().min(1).max(100).default(50), vectorLimit: z.int().min(1).max(100).default(50),
  chunkLimit: z.int().min(1).max(1000).default(500), limit: z.int().min(1).max(20).default(20),
  rrfK: z.int().min(1).max(1000).default(60), vectorFailure: z.enum(['error', 'keyword']),
  totalTimeoutMs: z.int().min(1000).max(120_000).default(60_000),
}).strict();
export const recallCandidateSchema = z.object({ jobId: z.uuid(), jobVersionId: z.uuid(), rank: z.int().positive(),
  rrfScore: z.number().positive(), sources: z.array(z.object({ source: z.enum(['keyword', 'vector']), rank: z.int().positive() }).strict()).min(1).max(2),
}).strict();
export const recallResultSchema = z.object({ schemaVersion: z.literal(1), corpusVersion: versionNameSchema,
  corpusHash: z.string().regex(/^[a-f0-9]{64}$/), config: recallConfigSchema,
  embeddingVersion: versionNameSchema, indexSpec: indexCollectionSchema, candidates: z.array(recallCandidateSchema).max(20),
  degraded: z.boolean(), degradationReason: z.enum(['INDEX_NOT_READY', 'VECTOR_UNAVAILABLE', 'EMPTY_VECTOR_QUERY']).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.embeddingVersion !== value.indexSpec.embeddingVersion) ctx.addIssue({ code: 'custom', message: '索引版本不匹配' });
  if (value.degraded !== (value.degradationReason !== null)) ctx.addIssue({ code: 'custom', message: '降级状态必须带明确原因' });
  if (value.candidates.length > value.config.limit || new Set(value.candidates.map(item => item.jobVersionId)).size !== value.candidates.length) {
    ctx.addIssue({ code: 'custom', message: '候选必须唯一且不超过配置上限' });
  }
  for (const [index, item] of value.candidates.entries()) {
    if (item.rank !== index + 1 || new Set(item.sources.map(source => source.source)).size !== item.sources.length
      || (value.degraded && item.sources.some(source => source.source === 'vector'))) {
      ctx.addIssue({ code: 'custom', path: ['candidates', index], message: '候选顺序或来源无效' });
    }
  }
});
export type RecallResult = z.infer<typeof recallResultSchema>;
