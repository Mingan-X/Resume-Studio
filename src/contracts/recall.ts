import { z } from 'zod';
import { versionNameSchema } from './jobs.js';

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
