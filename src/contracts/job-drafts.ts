import { z } from 'zod';
import { dimensionWeightsSchema, jobRequirementSchema, stableIdSchema } from './jobs.js';

export const jobMetadataSchema = z.object({ title: z.string().trim().min(1).max(256),
  city: z.string().trim().min(1).max(128).nullable(), level: z.string().trim().min(1).max(128).nullable(),
  skills: z.array(z.string().trim().min(1).max(128)).max(100),
}).strict();
export const jobBodySchema = z.string().min(1).max(200_000).refine(body => !!body.trim());
export const createJobDraftSchema = jobMetadataSchema.extend({ body: jobBodySchema });
export const editJobDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('body'), body: jobBodySchema }).strict(),
  z.object({ kind: z.literal('metadata'), metadata: jobMetadataSchema }).strict(),
  z.object({ kind: z.literal('requirement-upsert'), requirement: jobRequirementSchema }).strict(),
  z.object({ kind: z.literal('requirement-delete'), stableId: stableIdSchema }).strict(),
  z.object({ kind: z.literal('weights'), dimensionWeights: dimensionWeightsSchema }).strict(),
]);
