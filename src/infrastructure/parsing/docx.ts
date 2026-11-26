import mammoth from 'mammoth';
import { z } from 'zod';
import { ParseFailure, parserOutputSchema } from '../../modules/parsing/contracts.js';
import type { ParserLimits, ParserOutput } from '../../modules/parsing/contracts.js';

// The documented transform hook is version-pinned; validate nodes before extracting text.
const nodeSchema = z.object({ type: z.string(), value: z.string().optional(),
  children: z.array(z.unknown()).optional(), breakType: z.string().optional() }).passthrough();

export async function parseDocx(bytes: Buffer, limits: ParserLimits): Promise<ParserOutput> {
  const blocks: ParserOutput['blocks'] = [];
  let paragraph = 0, tableIndex = 0, total = 0;
  const text = (input: unknown, depth = 0): string => {
    if (depth > 64) throw new ParseFailure('CORRUPT_FILE');
    const node = nodeSchema.parse(input);
    if (node.type === 'text') return node.value ?? '';
    if (node.type === 'tab') return '\t';
    if (node.type === 'break') return '\n';
    if (node.type === 'image') return '';
    return (node.children ?? []).map(child => text(child, depth + 1)).join('');
  };
  type Table = { index: number; row: number; cell: number };
  const walk = (input: unknown, table: Table | null = null, depth = 0): void => {
    if (depth > 64) throw new ParseFailure('CORRUPT_FILE');
    const node = nodeSchema.parse(input);
    if (node.type === 'paragraph') {
      const value = text(input).replace(/\r\n?/g, '\n').normalize('NFC'), ordinal = paragraph++;
      total += value.length;
      if (total > limits.maxText) throw new ParseFailure('TEXT_LIMIT');
      if (value.trim()) blocks.push({ text: value, location: { kind: 'DOCX', paragraph: ordinal, table } });
      return;
    }
    if (node.type === 'table') {
      const index = tableIndex++;
      for (const [row, rowNode] of (node.children ?? []).entries()) {
        const parsed = nodeSchema.parse(rowNode);
        if (parsed.type !== 'tableRow') throw new ParseFailure('CORRUPT_FILE');
        for (const [cell, cellNode] of (parsed.children ?? []).entries()) walk(cellNode, { index, row, cell }, depth + 1);
      }
      return;
    }
    for (const child of node.children ?? []) walk(child, table, depth + 1);
  };
  try {
    await mammoth.convertToHtml({ buffer: bytes }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false, includeDefaultStyleMap: false,
      // Do not read images, generate user-visible HTML, or let links trigger resource access.
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      transformDocument: (document: unknown): unknown => { walk(document); return document; },
    });
    if (!blocks.length) throw new ParseFailure('EMPTY_TEXT');
    return parserOutputSchema.parse({ parserVersion: 'mammoth@1.13.0/adapter-v1', blocks, warnings: [] });
  } catch (error) { throw error instanceof ParseFailure ? error : new ParseFailure('CORRUPT_FILE'); }
}
