import { z } from 'zod';
import { extractedDocumentSchema, sha256Schema } from './evidence.js';

export const documentMimeSchema = z.enum([
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export const fileAssetSchema = z.object({
  id: z.uuid(), ownerId: z.uuid(), storageKey: z.uuid(), sha256: sha256Schema,
  mime: documentMimeSchema, size: z.int().positive(), createdAt: z.iso.datetime(),
}).strict();
export const resumeSummarySchema = z.object({
  id: z.uuid(), latestVersionId: z.uuid(), version: z.int().positive(), createdAt: z.iso.datetime(),
}).strict();
export const resumeVersionResponseSchema = z.object({
  resumeId: z.uuid(), resumeVersionId: z.uuid(), version: z.int().positive(),
  file: z.object({ sha256: sha256Schema, mime: documentMimeSchema, size: z.int().positive() }).strict(),
  extractedDocument: extractedDocumentSchema, createdAt: z.iso.datetime(),
}).strict().refine(value => value.extractedDocument.sourceVersionId === value.resumeVersionId
  && value.extractedDocument.fileHash === value.file.sha256);
export const resumeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export const resumeListResponseSchema = z.object({
  items: z.array(resumeSummarySchema), nextCursor: z.string().nullable(),
}).strict();
export const resumeVersionPathSchema = z.object({ resumeId: z.uuid(), versionId: z.uuid() }).strict();
export const uploadFailureReasonSchema = z.enum([
  'FILE_TOO_LARGE', 'UNSUPPORTED_TYPE', 'SIGNATURE_MISMATCH', 'ENCRYPTED_FILE',
  'CORRUPT_FILE', 'SCANNED_PDF', 'EMPTY_TEXT', 'PAGE_LIMIT', 'TEXT_LIMIT',
  'ZIP_LIMIT', 'UNSAFE_ARCHIVE', 'PARSER_TIMEOUT', 'PARSER_MEMORY_LIMIT',
]);
// T1 contracts only; HTTP registration and shared error extension belong to T8.
export const uploadFailureSchema = z.object({
  code: z.enum(['PAYLOAD_TOO_LARGE', 'UNSUPPORTED_FILE']), reason: uploadFailureReasonSchema,
  message: z.string(), retryable: z.literal(false), requestId: z.uuid(),
}).strict();
export type FileAsset = z.infer<typeof fileAssetSchema>;
export type ResumeVersionResponse = z.infer<typeof resumeVersionResponseSchema>;
export type UploadFailureReason = z.infer<typeof uploadFailureReasonSchema>;
