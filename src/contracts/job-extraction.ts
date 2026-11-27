import { z } from 'zod';
import { requirementsSchema, versionNameSchema } from './jobs.js';
import { sha256Schema } from './evidence.js';
import { modelUsageSchema } from './model.js';

export const jdSuggestionSchema = z.object({ requirements: requirementsSchema }).strict();
export const jdExtractionResultSchema = z.object({
  schemaVersion: z.literal(1), jobVersionId: z.uuid(), inputHash: sha256Schema,
  promptVersion: z.literal('jd-extract-v1'), modelConfigVersion: versionNameSchema,
  suggestions: jdSuggestionSchema, attempts: z.int().positive(), usage: modelUsageSchema.nullable(),
}).strict();
