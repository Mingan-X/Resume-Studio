import { z } from 'zod';
import { sha256Schema } from './evidence.js';
import { taskFailureCodeSchema } from './tasks.js';
export const analysisSummarySchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), inputHash: sha256Schema,
  status: z.enum(['SUCCEEDED','PARTIAL','FAILED']), profileId: z.uuid().nullable(), candidateSetId: z.uuid().nullable(), matchPlanId: z.uuid().nullable(),
  scoreSetId: z.uuid().nullable().optional(), rankingId: z.uuid().nullable().optional(),
  profileError: taskFailureCodeSchema.nullable(), matchingError: taskFailureCodeSchema.nullable(), degraded: z.boolean(),
  planned: z.int().nonnegative(), completed: z.int().nonnegative(), failed: z.int().nonnegative(), truncated: z.int().nonnegative(), pending: z.int().nonnegative(),
}).strict().refine(value => value.completed + value.failed + value.truncated + value.pending === value.planned);
export const analysisCompletionSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('analysis'), inputHash: sha256Schema, summaryId: z.uuid() }).strict();
