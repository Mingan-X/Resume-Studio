import { z } from 'zod';
import { versionNameSchema } from '../../contracts/jobs.js';
import type { EmbeddingPort, EmbeddingResponse } from '../../modules/embeddings/embedding.port.js';
import { EmbeddingFailure } from '../../modules/embeddings/embedding.port.js';
import { redactContactText } from '../../modules/models/privacy.js';

const dimensionsSchema = z.union([z.literal(64), z.literal(128), z.literal(256), z.literal(512), z.literal(768), z.literal(1024), z.literal(1536), z.literal(2048)]);
export const bailianEmbeddingConfigSchema = z.object({ embeddingVersion: versionNameSchema,
  model: z.literal('text-embedding-v4'), dimensions: dimensionsSchema,
  endpoint: z.url(), apiKey: z.string().min(1).max(4096), currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
const responseSchema = z.object({ model: z.string(), data: z.array(z.object({ index: z.int().nonnegative(),
  embedding: z.union([z.array(z.number()), z.string()]),
})).min(1).max(10), usage: z.object({ prompt_tokens: z.int().nonnegative(), total_tokens: z.int().nonnegative() }).optional() });

// Official OpenAI-compatible embedding REST; no SDK retries or default production configuration.
export class BailianEmbedding implements EmbeddingPort {
  readonly provenance = 'bailian';
  readonly embeddingVersion: string;
  readonly dimensions: number;
  private readonly config: z.infer<typeof bailianEmbeddingConfigSchema>;
  constructor(raw: unknown, options: { allowLocalTestEndpoint?: boolean } = {}) {
    this.config = bailianEmbeddingConfigSchema.parse(raw);
    const url = new URL(this.config.endpoint);
    const local = options.allowLocalTestEndpoint === true && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    const official = url.protocol === 'https:' && !url.port && /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(url.hostname);
    if ((!local && !official) || url.username || url.password || url.hash || url.search
      || url.pathname !== '/compatible-mode/v1/embeddings') throw new Error('BAILIAN_ENDPOINT_INVALID');
    this.embeddingVersion = this.config.embeddingVersion; this.dimensions = this.config.dimensions;
  }

  async embed(rawTexts: string[], signal: AbortSignal): Promise<EmbeddingResponse> {
    signal.throwIfAborted();
    const texts = z.array(z.string().trim().min(1)).min(1).max(10).parse(rawTexts).map(text => redactContactText(text));
    // Conservative UTF-8 bound rather than claiming a character count is a tokenizer.
    if (texts.some(text => Buffer.byteLength(text) > 8192)) throw new EmbeddingFailure('BUDGET_EXHAUSTED');
    try {
      const response = await fetch(this.config.endpoint, { method: 'POST', signal, redirect: 'manual',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, input: texts, dimensions: this.dimensions, encoding_format: 'float' }) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new EmbeddingFailure(response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UPSTREAM_5XX' : 'OUTPUT_INVALID');
      }
      const reader = response.body?.getReader(); if (!reader) throw new EmbeddingFailure('OUTPUT_INVALID');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const read = await reader.read(); if (read.done) break;
          length += read.value.byteLength;
          if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new EmbeddingFailure('OUTPUT_INVALID'); }
          chunks.push(read.value);
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      const result = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      if (result.model !== this.config.model || result.data.length !== texts.length) throw new EmbeddingFailure('OUTPUT_INVALID');
      const ordered = [...result.data].sort((a, b) => a.index - b.index);
      const vectors = ordered.map((item, index) => {
        if (item.index !== index) throw new EmbeddingFailure('OUTPUT_INVALID');
        let vector: number[];
        if (typeof item.embedding === 'string') {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.embedding) || item.embedding.length > 12000) throw new EmbeddingFailure('OUTPUT_INVALID');
          const bytes = Buffer.from(item.embedding, 'base64');
          if (bytes.length !== this.dimensions * 4 || bytes.toString('base64') !== item.embedding) throw new EmbeddingFailure('OUTPUT_INVALID');
          vector = Array.from({ length: this.dimensions }, (_, ordinal) => bytes.readFloatLE(ordinal * 4));
        } else vector = item.embedding;
        return z.array(z.number()).length(this.dimensions).parse(vector);
      });
      if (result.usage && result.usage.total_tokens < result.usage.prompt_tokens) throw new EmbeddingFailure('OUTPUT_INVALID');
      return { vectors, usage: result.usage ? { inputTokens: result.usage.total_tokens, costMicros: null, currency: this.config.currency } : null };
    } catch (error) {
      if (signal.aborted) throw new EmbeddingFailure('CANCELLED');
      if (error instanceof EmbeddingFailure) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new EmbeddingFailure('OUTPUT_INVALID');
      throw new EmbeddingFailure('UNAVAILABLE');
    }
  }
}
