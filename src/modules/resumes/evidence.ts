import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evidenceRefSchema, extractedDocumentSchema } from '../../contracts/evidence.js';
import type { EvidenceRef, ExtractedDocument } from '../../contracts/evidence.js';
import { parserOutputSchema } from '../parsing/contracts.js';

export const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export function extractedDocument(versionId: string, fileHash: string, raw: unknown): ExtractedDocument {
  const output = parserOutputSchema.parse(raw);
  return extractedDocumentSchema.parse({ schemaVersion: 1, sourceType: 'RESUME', sourceVersionId: versionId,
    fileHash, parserVersion: output.parserVersion, normalizationVersion: 'text-v1', warnings: output.warnings,
    blocks: output.blocks.map((block, ordinal) => {
      const text = block.text.replace(/\r\n?/g, '\n').normalize('NFC');
      const hex = textHash(JSON.stringify([versionId, output.parserVersion, ordinal, text]));
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      return { id, ordinal, text, textHash: textHash(text), location: block.location };
    }),
  });
}
function boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1), current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}
export function validateEvidence(ownerId: string, storedOwnerId: string, rawDocument: unknown, rawRef: unknown): EvidenceRef {
  const owner = z.uuid().parse(ownerId), storedOwner = z.uuid().parse(storedOwnerId);
  const document = extractedDocumentSchema.parse(rawDocument), ref = evidenceRefSchema.parse(rawRef);
  const block = document.blocks.find(block => block.id === ref.blockId);
  if (owner !== storedOwner || ref.sourceType !== document.sourceType || ref.sourceVersionId !== document.sourceVersionId
    || !block || ref.end > block.text.length || !boundary(block.text, ref.start) || !boundary(block.text, ref.end)
    || block.text.slice(ref.start, ref.end) !== ref.quote || textHash(block.text) !== block.textHash) {
    throw new Error('INVALID_EVIDENCE');
  }
  return ref;
}
