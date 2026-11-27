import { z } from 'zod';
import { evidenceRefSchema, sha256Schema } from './evidence.js';
import { jobVersionSchema, stableIdSchema } from './jobs.js';
import { taskFailureCodeSchema } from './tasks.js';
export const requirementJudgmentSchema = z.object({ requirementId: stableIdSchema, verdict: z.enum(['met', 'partial', 'unmet', 'unknown']),
  evidenceRefs: z.array(evidenceRefSchema).max(100), reason: z.string().trim().min(1).max(4000),
}).strict().refine(value => value.verdict === 'unknown' || value.evidenceRefs.length > 0, '已知判断必须有证据');
export const matchModelOutputSchema = z.object({ judgments: z.array(requirementJudgmentSchema).min(1).max(10) }).strict()
  .refine(value => new Set(value.judgments.map(item => item.requirementId)).size === value.judgments.length, '要求不能重复');
export const storedJudgmentSchema = requirementJudgmentSchema.safeExtend({ jobVersionId: z.uuid(), method: z.enum(['model', 'rule']) });
export const matchPlanSchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), candidateSetId: z.uuid(), candidateSetHash: sha256Schema,
  extractionId: z.uuid(), maxJudgments: z.int().min(1).max(400),
  jobs: z.array(jobVersionSchema).max(20),
  requirements: z.array(z.object({ jobVersionId: z.uuid(), requirementId: stableIdSchema, ordinal: z.int().nonnegative(), allocated: z.boolean() }).strict()).max(8000),
}).strict().superRefine((value, ctx) => {
  if (value.jobs.some(job => job.status !== 'PUBLISHED') || new Set(value.jobs.map(job => job.id)).size !== value.jobs.length) ctx.addIssue({ code: 'custom', message: '岗位快照无效' });
  const keys = value.requirements.map(item => JSON.stringify([item.jobVersionId, item.requirementId]));
  if (new Set(keys).size !== keys.length || value.requirements.some((item, i) => item.ordinal !== i || item.allocated !== (i < value.maxJudgments))) ctx.addIssue({ code: 'custom', message: '预算计划顺序无效' });
  const expected = value.jobs.flatMap(job => job.requirements.map(item => JSON.stringify([job.id, item.stableId])));
  if (expected.length !== keys.length || expected.some(key => !keys.includes(key))) ctx.addIssue({ code: 'custom', message: '计划必须覆盖全部要求' });
});
export const requirementExecutionSchema = z.discriminatedUnion('status', [
  z.object({ jobVersionId: z.uuid(), requirementId: stableIdSchema, ordinal: z.int().nonnegative(), status: z.literal('PENDING'), judgment: z.null(), errorCode: z.null() }).strict(),
  z.object({ jobVersionId: z.uuid(), requirementId: stableIdSchema, ordinal: z.int().nonnegative(), status: z.literal('DONE'), judgment: storedJudgmentSchema, errorCode: z.null() }).strict(),
  z.object({ jobVersionId: z.uuid(), requirementId: stableIdSchema, ordinal: z.int().nonnegative(), status: z.enum(['FAILED', 'BUDGET']), judgment: z.null(), errorCode: taskFailureCodeSchema }).strict(),
]);
export type MatchPlan = z.infer<typeof matchPlanSchema>;
export type StoredJudgment = z.infer<typeof storedJudgmentSchema>;
