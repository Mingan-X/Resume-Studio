import { open } from 'node:fs/promises';
import { z } from 'zod';
import { evaluateQuality } from '../../modules/evaluation/quality.js';

async function read(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const limit = 20 * 1024 * 1024, info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('EVALUATION_FILE_LIMIT');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > limit) throw new Error('EVALUATION_FILE_LIMIT');
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8')); return value;
  } finally { await file.close(); }
}
try {
  const [dataset, run, annotations, k] = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1),
    z.coerce.number().int().min(1).max(300)]).parse(process.argv.slice(2));
  console.log(JSON.stringify(evaluateQuality(await read(dataset), await read(run), await read(annotations), k), null, 2));
} catch { console.error(JSON.stringify({ code: 'QUALITY_EVALUATION_FAILED' })); process.exitCode = 1; }
