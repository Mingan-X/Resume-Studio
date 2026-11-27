import { z } from 'zod';
import { versionNameSchema } from './jobs.js';
import { taskBudgetSchema } from './tasks.js';

export const jobConfirmationSchema = z.object({ hardRequirementsConfirmed: z.boolean(), weightsConfirmed: z.boolean() }).strict();
export const jobIndexTargetSchema = z.object({ embeddingVersion: versionNameSchema, indexVersion: versionNameSchema,
  chunkerVersion: versionNameSchema, componentVersion: versionNameSchema, budget: taskBudgetSchema,
}).strict();
export type JobIndexTarget = z.infer<typeof jobIndexTargetSchema>;
export const jobPublicationResultSchema = z.object({ jobVersionId: z.uuid(), taskId: z.uuid() }).strict();
