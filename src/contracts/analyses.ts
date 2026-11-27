import { z } from 'zod';
import { versionNameSchema } from './jobs.js';

export const createAnalysisRequestSchema = z.object({
  resumeVersionId: z.uuid().transform(value => value.toLowerCase()), asOfDate: z.iso.date(),
  // Existing corpus identity is (ownerId, version), not a second synthetic UUID.
  jobCorpusVersionId: versionNameSchema,
}).strict();
export const createAnalysisResponseSchema = z.object({ taskId: z.uuid(),
  statusUrl: z.string().regex(/^\/api\/v1\/tasks\/[a-f0-9-]{36}$/),
}).strict();
export type CreateAnalysisRequest = z.infer<typeof createAnalysisRequestSchema>;
