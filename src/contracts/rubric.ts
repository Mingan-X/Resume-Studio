import { z } from 'zod';
import { dimensionSchema, stableIdSchema, versionNameSchema } from './jobs.js';

export const rubricLevelSchema = z.object({ level: z.int().min(1).max(5), score: z.number().min(0).max(100),
  behavior: z.string().trim().min(1), evidenceThreshold: z.string().trim().min(1),
  features: z.array(z.object({ featureId: stableIdSchema, description: z.string().trim().min(1) }).strict()).min(1),
}).strict();
export const rubricVersionSchema = z.object({ schemaVersion: z.literal(1), version: versionNameSchema,
  provenance: z.enum(['SYNTHETIC', 'AI_DRAFT']), reviewStatus: z.enum(['TEST_ONLY', 'PENDING_REVIEW', 'APPROVED']),
  dimensions: z.array(z.object({ dimension: dimensionSchema, levels: z.array(rubricLevelSchema).length(5) }).strict()).length(6),
}).strict().superRefine((rubric, ctx) => {
  if ((rubric.provenance === 'SYNTHETIC') !== (rubric.reviewStatus === 'TEST_ONLY')) ctx.addIssue({ code: 'custom', message: '测试Rubric不可注册为正式规则' });
  if (new Set(rubric.dimensions.map(item => item.dimension)).size !== 6) ctx.addIssue({ code: 'custom', message: '六维必须完整且唯一' });
  const features = new Set<string>();
  rubric.dimensions.forEach((dimension, index) => {
    if (new Set(dimension.levels.map(item => item.level)).size !== 5) ctx.addIssue({ code: 'custom', path: ['dimensions', index], message: 'L1–L5必须完整且唯一' });
    for (const level of dimension.levels) for (const feature of level.features) {
      if (features.has(feature.featureId)) ctx.addIssue({ code: 'custom', message: 'featureId必须全版本唯一' });
      features.add(feature.featureId);
    }
  });
});
export type RubricVersion = z.infer<typeof rubricVersionSchema>;
