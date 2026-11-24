import { Inject, Injectable } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { INFRA_CONFIG } from '../tokens.js';
import type { InfrastructureConfig } from '../config.js';

@Injectable()
export class VectorService {
  readonly client: QdrantClient;

  constructor(@Inject(INFRA_CONFIG) config: InfrastructureConfig) {
    this.client = new QdrantClient({
      url: config.qdrantUrl, apiKey: config.qdrantApiKey,
      timeout: 5_000, maxConnections: 3,
    });
  }
}
