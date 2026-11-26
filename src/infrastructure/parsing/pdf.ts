import { z } from 'zod';
import { ParseFailure, parserOutputSchema } from '../../modules/parsing/contracts.js';
import type { ParserLimits, ParserOutput } from '../../modules/parsing/contracts.js';

const itemSchema = z.object({ str: z.string(), dir: z.string(), width: z.number().nonnegative(), height: z.number().nonnegative(),
  transform: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]), hasEOL: z.boolean() });

export async function parsePdf(bytes: Buffer, limits: ParserLimits): Promise<ParserOutput> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0,
    stopAtErrors: true, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
    useWasm: false, enableXfa: false, isOffscreenCanvasSupported: false,
  });
  let encrypted = false;
  task.onPassword = () => { encrypted = true; void task.destroy(); };
  try {
    const document = await task.promise;
    if (document.numPages > limits.maxPages) throw new ParseFailure('PAGE_LIMIT');
    const blocks: ParserOutput['blocks'] = [];
    const warnings = new Set<ParserOutput['warnings'][number]>();
    let textSize = 0, emptyPages = 0, imagePages = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: true });
      const items = content.items.filter(item => 'str' in item).map(item => itemSchema.parse(item)).filter(item => item.str.trim());
      if (!items.length) {
        emptyPages++;
        const operations = await page.getOperatorList();
        if (operations.fnArray.some(code => code === pdfjs.OPS.paintImageXObject || code === pdfjs.OPS.paintInlineImageXObject)) imagePages++;
        page.cleanup(); continue;
      }
      items.sort((a, b) => Math.round(b.transform[5] / 2) - Math.round(a.transform[5] / 2)
        || a.transform[4] - b.transform[4]);
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!, next = items[index + 1];
        if (next && Math.abs(item.transform[5] - next.transform[5]) <= 2
          && next.transform[4] - (item.transform[4] + item.width) > 30) warnings.add('READING_ORDER_UNCERTAIN');
        const [a, b, c, d] = item.transform;
        if (b !== 0 || c !== 0 || a <= 0 || d <= 0 || item.dir !== 'ltr') warnings.add('READING_ORDER_UNCERTAIN');
        const text = item.str.replace(/\r\n?/g, '\n').normalize('NFC');
        textSize += text.length;
        if (textSize > limits.maxText) throw new ParseFailure('TEXT_LIMIT');
        // Baseline/extents are not a reliable glyph bounding rectangle; provide page only.
        blocks.push({ text, location: { kind: 'PDF', page: pageNumber, bounds: null } });
      }
      page.cleanup();
    }
    if (!blocks.length) throw new ParseFailure(imagePages ? 'SCANNED_PDF' : 'EMPTY_TEXT');
    if (emptyPages) warnings.add('PARTIAL_TEXT_LAYER');
    return parserOutputSchema.parse({ parserVersion: `pdfjs-dist@${pdfjs.version}/adapter-v1`, blocks, warnings: [...warnings].sort() });
  } catch (error) {
    if (encrypted || z.object({ name: z.literal('PasswordException') }).safeParse(error).success) throw new ParseFailure('ENCRYPTED_FILE');
    throw error instanceof ParseFailure ? error : new ParseFailure('CORRUPT_FILE');
  } finally { await task.destroy(); }
}
