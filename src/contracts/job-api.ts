import { z } from 'zod';
import { jobVersionSchema } from './jobs.js';
export const jobPathSchema = z.object({ jobId: z.uuid() }).strict();
export const jobVersionPathSchema = z.object({ jobId: z.uuid(), versionId: z.uuid() }).strict();
export const jobListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(512).optional() }).strict();
// owner is a storage invariant, never a client-visible identity selector.
export const jobVersionResponseSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), jobId: z.uuid(), version: z.int().positive(),
  title: z.string(), city: z.string().nullable(), level: z.string().nullable(), skills: z.array(z.string()),
  document: jobVersionSchema.options[0].shape.document,
  requirements: jobVersionSchema.options[0].shape.requirements,
  dimensionWeights: jobVersionSchema.options[0].shape.dimensionWeights,
  hardRequirementsConfirmed: z.boolean(), weightsConfirmed: z.boolean(), createdAt: z.iso.datetime(),
  status: z.enum(['DRAFT', 'PUBLISHED']), contentHash: z.string().nullable(), publishedAt: z.iso.datetime().nullable(),
  indexStatus: z.enum(['NOT_REQUESTED', 'PENDING', 'READY', 'FAILED']),
}).strict();
export const jobListResponseSchema = z.object({ items: z.array(z.object({ id: z.uuid(), createdAt: z.iso.datetime(),
  latestVersion: jobVersionResponseSchema }).strict()), nextCursor: z.string().nullable() }).strict();
