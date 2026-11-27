import { z } from 'zod';
import { sha256Schema } from './evidence.js';
import { versionNameSchema } from './jobs.js';

export const indexCollectionSchema = z.object({ schemaVersion: z.literal(1), project: z.literal('resume-studio'),
  kind: z.literal('job-index'), ownerId: z.uuid(), embeddingVersion: versionNameSchema, indexVersion: versionNameSchema,
  dimensions: z.int().min(1).max(8192), provenance: z.enum(['synthetic', 'bailian']),
  chunkerVersion: z.literal('jd-chunks-v1'), componentVersion: z.literal('job-index-v1'),
}).strict();
export type IndexCollection = z.infer<typeof indexCollectionSchema>;
export const indexedChunkSchema = z.object({ chunkId: z.uuid(), start: z.int().nonnegative(), end: z.int().positive(),
  text: z.string().min(1).max(1000), contentHash: sha256Schema,
}).strict();
export const indexPointPayloadSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('job-chunk'),
  ownerId: z.uuid(), visibility: z.literal('private'), jobVersionId: z.uuid(), chunkId: z.uuid(),
  embeddingVersion: versionNameSchema, indexVersion: versionNameSchema, contentHash: sha256Schema,
  requirementsHash: sha256Schema, chunkHash: sha256Schema,
}).strict();
export const jobIndexCompletionSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('job-index'),
  inputHash: sha256Schema, completedUnits: z.int().positive().max(400),
  collection: z.string().regex(/^rs_jobs_[a-zA-Z0-9_-]+$/), spec: indexCollectionSchema,
  points: z.array(z.uuid()).min(1).max(400),
}).strict().refine(value => value.completedUnits === value.points.length && new Set(value.points).size === value.points.length);
export type JobIndexCompletion = z.infer<typeof jobIndexCompletionSchema>;
