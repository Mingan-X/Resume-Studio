import { open } from 'node:fs/promises';
import { z } from 'zod';
import { evaluateRecall } from '../../modules/recall/evaluation.js';

async function read(path: string) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('EVALUATION_FILE_LIMIT');
    const buffer = Buffer.alloc(10 * 1024 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > 10 * 1024 * 1024) throw new Error('EVALUATION_FILE_LIMIT');
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8')); return value;
  } finally { await file.close(); }
}
try {
  const [annotationPath, runPath, k] = z.tuple([z.string().min(1), z.string().min(1), z.coerce.number().int().min(1).max(1000)]).parse(process.argv.slice(2));
  const annotations = await read(annotationPath), run = await read(runPath);
  console.log(JSON.stringify(evaluateRecall(annotations, run, k), null, 2));
} catch { console.error(JSON.stringify({ code: 'RECALL_EVALUATION_FAILED' })); process.exitCode = 1; }
