import { z } from 'zod';
import { uploadFailureReasonSchema } from '../../contracts/resumes.js';
import { evidenceLocationSchema, parserWarningSchema } from '../../contracts/evidence.js';

export const parserLimitsSchema = z.object({
  maxBytes: z.int().positive().max(10 * 1024 * 1024).default(10 * 1024 * 1024),
  maxPages: z.int().positive().max(30).default(30),
  maxText: z.int().positive().max(200_000).default(200_000),
  maxEntries: z.int().positive().max(1000).default(1000),
  maxExpandedBytes: z.int().positive().max(50 * 1024 * 1024).default(50 * 1024 * 1024),
  maxEntryBytes: z.int().positive().max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  maxCompressionRatio: z.number().positive().max(100).default(100),
  timeoutMs: z.int().min(100).max(15_000).default(15_000),
  heapMiB: z.int().min(16).max(128).default(128),
  rssMiB: z.int().min(16).max(256).default(256),
}).strict();
export type ParserLimits = z.infer<typeof parserLimitsSchema>;
export const parserOutputSchema = z.object({
  parserVersion: z.string().min(1).max(128),
  blocks: z.array(z.object({ text: z.string().min(1), location: evidenceLocationSchema }).strict()).min(1),
  warnings: z.array(parserWarningSchema),
}).strict();
export type ParserOutput = z.infer<typeof parserOutputSchema>;
export const parserResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: parserOutputSchema }).strict(),
  z.object({ ok: z.literal(false), reason: uploadFailureReasonSchema }).strict(),
]);
export const parserRequestSchema = z.object({
  filename: z.string().min(1).max(255), mime: z.string().max(128),
  content: z.string().max(14 * 1024 * 1024), limits: parserLimitsSchema,
}).strict();
export class ParseFailure extends Error {
  constructor(readonly reason: z.infer<typeof uploadFailureReasonSchema>) { super(reason); this.name = 'ParseFailure'; }
}
export interface ParserPort {
  parse(bytes: Buffer, filename: string, mime: string, signal?: AbortSignal): Promise<ParserOutput>;
}
