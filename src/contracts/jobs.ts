import { z } from 'zod';
import { evidenceBlockSchema, evidenceRefSchema, sha256Schema } from './evidence.js';

export const dimensionIds = ['technical_depth', 'engineering', 'business_understanding',
  'project_impact', 'collaboration', 'growth'] as const;
export const dimensionSchema = z.enum(dimensionIds);
export const versionNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
export const stableIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const weight = z.number().nonnegative();
export const jdDocumentSchema = z.object({
  schemaVersion: z.literal(1), sourceType: z.literal('JD'), sourceVersionId: z.uuid(),
  normalizationVersion: z.literal('text-v1'), chunkerVersion: z.literal('jd-text-v1'),
  textHash: sha256Schema, blocks: z.array(evidenceBlockSchema).length(1),
}).strict().refine(doc => doc.blocks[0]!.ordinal === 0 && doc.blocks[0]!.location.kind === 'TEXT'
  && doc.blocks[0]!.location.paragraph === 0 && !!doc.blocks[0]!.text.trim()
  && doc.blocks[0]!.textHash === doc.textHash, { message: 'JD正文块无效' });

export const jobRequirementSchema = z.object({
  stableId: stableIdSchema, dimension: dimensionSchema, kind: z.enum(['HARD', 'SOFT']),
  description: z.string().trim().min(1).max(4000),
  threshold: z.object({ operator: z.enum(['gte', 'lte', 'eq']),
    value: z.union([z.number(), z.string().min(1).max(256)]), unit: z.string().min(1).max(64),
  }).strict().nullable(),
  weight, sourceRef: evidenceRefSchema.refine(ref => ref.sourceType === 'JD'),
  priority: z.int().nonnegative(),
}).strict();
export const requirementsSchema = z.array(jobRequirementSchema).max(400).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.stableId)) ctx.addIssue({ code: 'custom', path: [index, 'stableId'], message: '要求ID重复' });
    seen.add(item.stableId);
  });
});
export const dimensionWeightsSchema = z.array(z.object({ dimension: dimensionSchema, weight }).strict())
  .length(6).superRefine((items, ctx) => {
    if (new Set(items.map(item => item.dimension)).size !== 6) ctx.addIssue({ code: 'custom', message: '六维权重必须完整且唯一' });
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    if (!Number.isFinite(total) || total <= 0) ctx.addIssue({ code: 'custom', message: '总权重必须有限且大于0' });
  });
export const jobScoringInputSchema = z.object({ requirements: requirementsSchema.min(1),
  dimensionWeights: dimensionWeightsSchema,
}).strict().superRefine((value, ctx) => {
  let participating = 0;
  for (const [index, entry] of value.dimensionWeights.entries()) {
    const items = value.requirements.filter(item => item.dimension === entry.dimension);
    if (!items.length || entry.weight === 0) continue;
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    if (!Number.isFinite(total) || total <= 0) ctx.addIssue({ code: 'custom', path: ['dimensionWeights', index], message: '有效维度内要求权重之和必须有限且大于0' });
    participating += entry.weight;
  }
  if (participating <= 0) ctx.addIssue({ code: 'custom', message: '参与计算的总权重必须大于0' });
});
export const jobSchema = z.object({ id: z.uuid(), ownerId: z.uuid(), createdAt: z.iso.datetime() }).strict();
const versionFields = {
  schemaVersion: z.literal(1), id: z.uuid(), ownerId: z.uuid(), jobId: z.uuid(), version: z.int().positive(),
  title: z.string().trim().min(1).max(256), city: z.string().trim().min(1).max(128).nullable(),
  level: z.string().trim().min(1).max(128).nullable(), skills: z.array(z.string().trim().min(1).max(128)).max(100),
  document: jdDocumentSchema, requirements: requirementsSchema, dimensionWeights: dimensionWeightsSchema,
  hardRequirementsConfirmed: z.boolean(), weightsConfirmed: z.boolean(), createdAt: z.iso.datetime(),
};
export const jobVersionSchema = z.discriminatedUnion('status', [
  z.object({ ...versionFields, status: z.literal('DRAFT'), contentHash: z.null(), publishedAt: z.null(), indexStatus: z.literal('NOT_REQUESTED') }).strict(),
  z.object({ ...versionFields, status: z.literal('PUBLISHED'), contentHash: sha256Schema,
    publishedAt: z.iso.datetime(), indexStatus: z.enum(['PENDING', 'READY', 'FAILED']),
    hardRequirementsConfirmed: z.literal(true), weightsConfirmed: z.literal(true),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.document.sourceVersionId !== value.id) ctx.addIssue({ code: 'custom', path: ['document'], message: 'JD版本不匹配' });
  if (value.status === 'PUBLISHED') {
    const result = jobScoringInputSchema.safeParse({ requirements: value.requirements, dimensionWeights: value.dimensionWeights });
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});
export type JobRequirement = z.infer<typeof jobRequirementSchema>;
export type JdDocument = z.infer<typeof jdDocumentSchema>;
export type JobVersion = z.infer<typeof jobVersionSchema>;
