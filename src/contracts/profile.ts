import { z } from 'zod';
import { dimensionSchema, stableIdSchema, versionNameSchema } from './jobs.js';
import { evidenceRefSchema, sha256Schema } from './evidence.js';
export const profileJudgmentSchema = z.object({ dimension: dimensionSchema, status: z.enum(['assessed', 'unknown']),
  level: z.int().min(1).max(5).nullable(), featureIds: z.array(stableIdSchema).max(100), evidenceRefs: z.array(evidenceRefSchema).max(100),
  rubricRefs: z.array(z.object({ rubricVersion: versionNameSchema, dimension: dimensionSchema, level: z.int().min(1).max(5), featureId: stableIdSchema }).strict()).max(100),
  reason: z.string().trim().min(1).max(4000),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'unknown' ? value.level !== null || value.featureIds.length !== 0 || value.rubricRefs.length !== 0
    : value.level === null || !value.featureIds.length || !value.rubricRefs.length || !value.evidenceRefs.length) ctx.addIssue({ code: 'custom', message: '画像状态与证据不一致' });
  if (new Set(value.featureIds).size !== value.featureIds.length) ctx.addIssue({ code: 'custom', message: '特征重复' });
});
export const profileModelOutputSchema = z.object({ judgments: z.array(profileJudgmentSchema).length(6) }).strict()
  .refine(value => new Set(value.judgments.map(item => item.dimension)).size === 6, '六维必须完整且唯一');
export const profileAssessmentSchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), resumeVersionId: z.uuid(),
  extractionId: z.uuid(), rubricVersion: versionNameSchema, rubricHash: sha256Schema, inputHash: sha256Schema,
  judgments: profileModelOutputSchema.shape.judgments,
  scores: z.array(z.object({ dimension: dimensionSchema, score: z.number().min(0).max(100).nullable() }).strict()).length(6),
}).strict().refine(value => new Set(value.judgments.map(item => item.dimension)).size === 6 && new Set(value.scores.map(item => item.dimension)).size === 6);
export type ProfileAssessment = z.infer<typeof profileAssessmentSchema>;
