import { z } from 'zod';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceTypeSchema = z.enum(['RESUME', 'JD']);
// Location fields remain provisional until the T5/T6 parser experiments.
export const evidenceLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PDF'), page: z.int().positive(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict().nullable(),
  }).strict(),
  z.object({ kind: z.literal('DOCX'), paragraph: z.int().nonnegative(),
    table: z.object({ index: z.int().nonnegative(), row: z.int().nonnegative(), cell: z.int().nonnegative() }).strict().nullable(),
  }).strict(),
  z.object({ kind: z.literal('TEXT'), paragraph: z.int().nonnegative() }).strict(),
]);
export const evidenceBlockSchema = z.object({
  id: z.uuid(), ordinal: z.int().nonnegative(), text: z.string().min(1),
  textHash: sha256Schema, location: evidenceLocationSchema,
}).strict();
export const evidenceRefSchema = z.object({
  sourceType: sourceTypeSchema, sourceVersionId: z.uuid(), blockId: z.uuid(),
  start: z.int().nonnegative(), end: z.int().positive(), quote: z.string().min(1),
}).strict().refine(ref => ref.end > ref.start && ref.quote.length === ref.end - ref.start,
  { message: '引用区间长度无效' });
export const parserWarningSchema = z.enum(['READING_ORDER_UNCERTAIN', 'TABLE_LAYOUT_LOST', 'PARTIAL_TEXT_LAYER']);
export const extractedDocumentSchema = z.object({
  schemaVersion: z.literal(1), sourceType: z.literal('RESUME'), sourceVersionId: z.uuid(),
  fileHash: sha256Schema, parserVersion: z.string().min(1).max(128),
  normalizationVersion: z.literal('text-v1'), blocks: z.array(evidenceBlockSchema).min(1),
  warnings: z.array(parserWarningSchema),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  document.blocks.forEach((block, index) => {
    if (ids.has(block.id) || block.ordinal !== index || !block.text.trim()) {
      context.addIssue({ code: 'custom', path: ['blocks', index], message: '文本块身份、顺序或内容无效' });
    }
    ids.add(block.id);
  });
});
export type EvidenceBlock = z.infer<typeof evidenceBlockSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;
