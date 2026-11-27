import {z} from 'zod';
import {taskResponseSchema} from './task-api.js';
import {reportInputSchema,pageQuerySchema} from './reports.js';
import {taskCountsSchema} from './tasks.js';
export {pageQuerySchema};
export const analysisPathSchema=z.object({taskId:z.uuid()}).strict();
export const analysisListItemSchema=z.object({id:z.uuid(),createdAt:z.iso.datetime(),input:reportInputSchema,
 status:z.enum(['QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','PARTIAL','FAILED','CANCELLED']),stage:z.string(),reportId:z.uuid().nullable()}).strict();
export const analysisListSchema=z.object({items:z.array(analysisListItemSchema),nextCursor:z.string().nullable()}).strict();
export const analysisDetailSchema=z.object({analysis:analysisListItemSchema,task:taskResponseSchema}).strict();
export const corpusListItemSchema=z.object({version:z.string(),createdAt:z.iso.datetime(),contentHash:z.string(),jobCount:z.int().nonnegative()}).strict();
export const analysisConfigurationViewSchema=z.object({configurationVersion:z.string(),rubricVersion:z.string(),scoringVersion:z.string(),promptVersion:z.string(),modelConfigVersion:z.string(),embeddingVersion:z.string()}).strict();
export const analysisOptionsSchema=z.object({resumes:z.array(z.object({resumeId:z.uuid(),resumeVersionId:z.uuid(),version:z.int().positive(),createdAt:z.iso.datetime(),fileHash:z.string()}).strict()),
 corpora:z.array(corpusListItemSchema),configuration:analysisConfigurationViewSchema.nullable(),nextResumeCursor:z.string().nullable(),nextCorpusCursor:z.string().nullable()}).strict();
export const analysisOptionsQuerySchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),resumeCursor:z.string().max(512).optional(),corpusCursor:z.string().max(512).optional()}).strict();
export const taskEventResponseSchema=z.object({taskId:z.uuid(),seq:z.int().positive(),stage:z.string().max(64),counts:taskCountsSchema,
 message:z.string().max(256),createdAt:z.iso.datetime()}).strict();
export const lastEventIdSchema=z.string().regex(/^(0|[1-9]\d{0,9})$/).transform(Number).pipe(z.int().max(2147483647));
