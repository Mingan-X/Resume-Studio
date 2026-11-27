import { z } from 'zod';
import { extractedDocumentSchema, sha256Schema } from './evidence.js';
import { parsedResumeSchema } from './parsed-resume.js';
import { profileAssessmentSchema } from './profile.js';
import { jobVersionResponseSchema } from './job-api.js';
import { requirementExecutionSchema } from './matching.js';
import { rankingResultSchema, scoreSetSchema } from './scoring.js';
import { realAnalysisInputSchema,taskFailureCodeSchema } from './tasks.js';
import { recallResultSchema } from './recall.js';

export const reportInputSchema = z.object({ resumeVersionId: z.uuid(), asOfDate: z.iso.date(),
  jobCorpusVersionId: z.string(), rubricVersion: z.string(), scoringVersion: z.string(),
  promptVersion: z.string(), modelConfigVersion: z.string(), embeddingVersion: z.string(),
}).strict();
export const reportWarningsSchema = z.array(z.enum(['PROFILE_UNAVAILABLE','MATCHING_UNAVAILABLE','DEGRADED_RECALL','INCOMPLETE_REQUIREMENTS','EMPTY_CANDIDATES']));
export const reportContentSchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), input: reportInputSchema,
  status: z.enum(['SUCCEEDED','PARTIAL']), extractedDocument: extractedDocumentSchema, parsedResume: parsedResumeSchema,
  extractionId: z.uuid(), profile: profileAssessmentSchema.nullable(),
  candidates: z.object({ id: z.uuid(), contentHash: sha256Schema, ordered: recallResultSchema.shape.candidates,
    degraded: z.boolean(), degradationReason: recallResultSchema.shape.degradationReason }).strict().nullable(),
  jobs: z.array(jobVersionResponseSchema).max(20), executions: z.array(requirementExecutionSchema).max(8000),
  scoreSetId: z.uuid().nullable(), ranking: rankingResultSchema.nullable(),
  candidateCoverage: z.object({ planned: z.int().nonnegative(), completed: z.int().nonnegative(), incomplete: z.int().nonnegative() }).strict(),
  requirementCoverage: z.object({ planned: z.int().nonnegative(), completed: z.int().nonnegative(), failed: z.int().nonnegative(), truncated: z.int().nonnegative(), pending: z.int().nonnegative() }).strict(),
  warnings: reportWarningsSchema,
  sectionErrors:z.object({profile:taskFailureCodeSchema.nullable(),matching:taskFailureCodeSchema.nullable()}).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.input.resumeVersionId !== value.parsedResume.resumeVersionId || value.input.resumeVersionId !== value.extractedDocument.sourceVersionId
    || value.candidateCoverage.completed + value.candidateCoverage.incomplete !== value.candidateCoverage.planned
    || value.requirementCoverage.completed + value.requirementCoverage.failed + value.requirementCoverage.truncated + value.requirementCoverage.pending !== value.requirementCoverage.planned
    || value.requirementCoverage.planned !== value.executions.length) ctx.addIssue({ code:'custom', message:'报告版本或覆盖率不一致' });
});
const reportMetadataSchema=z.object({ id: z.uuid(), taskId: z.uuid(), revision: z.int().positive(), rootReportId: z.uuid(), sourceReportId: z.uuid().nullable(),createdAt:z.iso.datetime() }).strict();
export const reportResponseSchema = reportMetadataSchema.extend({content:reportContentSchema}).strict().refine(value => value.content.taskId === value.taskId);
export const reportSummarySchema = reportMetadataSchema.extend({ status: z.enum(['SUCCEEDED','PARTIAL']), resumeVersionId:z.uuid(),
  topCount:z.int().min(0).max(10), warnings:reportWarningsSchema });
export const pageQuerySchema = z.object({ limit:z.coerce.number().int().min(1).max(100).default(20), cursor:z.string().min(1).max(512).optional() }).strict();
export const reportListSchema = z.object({ items:z.array(reportSummarySchema), nextCursor:z.string().nullable() }).strict();
export const reportPathSchema = z.object({ reportId:z.uuid() }).strict();
export const recomputeRequestSchema = z.object({ weights:scoreSetSchema.shape.weightOverrides.min(1) }).strict();
export const reportStorageInputSchema = realAnalysisInputSchema;
export type ReportContent = z.infer<typeof reportContentSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
