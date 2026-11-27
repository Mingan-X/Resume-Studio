import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { BailianEmbedding, bailianEmbeddingConfigSchema } from './bailian-embedding.js';
import { EmbeddingExecutor, embeddingPolicySchema } from '../../modules/embeddings/embedding-executor.js';

export const embeddingRuntimeConfigSchema = z.object({ connection: bailianEmbeddingConfigSchema, execution: embeddingPolicySchema }).strict()
  .refine(value => value.connection.currency === value.execution.currency);
export async function loadEmbeddingExecutor(rawPath: unknown) {
  const path = z.string().min(1).refine(isAbsolute).parse(rawPath), file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 65536) throw new Error('EMBEDDING_CONFIG_LIMIT');
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > 65536) throw new Error('EMBEDDING_CONFIG_LIMIT');
    const parsed = embeddingRuntimeConfigSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown);
    return new EmbeddingExecutor(new BailianEmbedding(parsed.connection), parsed.execution);
  } finally { await file.close(); }
}
