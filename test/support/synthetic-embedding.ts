import { createHash } from 'node:crypto';
import type { EmbeddingPort, EmbeddingResponse } from '../../src/modules/embeddings/embedding.port.js';

// Test fixture only. No production module or CLI registers this implementation.
export class SyntheticEmbedding implements EmbeddingPort {
  readonly embeddingVersion = 'fixture-only-embedding-v1';
  readonly provenance = 'synthetic';
  readonly dimensions = 8;
  embed(texts: string[], signal: AbortSignal): Promise<EmbeddingResponse> {
    signal.throwIfAborted();
    return Promise.resolve({ vectors: texts.map(text => {
      const hash = createHash('sha256').update(text).digest();
      return Array.from({ length: this.dimensions }, (_, index) => hash[index]! / 128 - 1);
    }), usage: null });
  }
}
