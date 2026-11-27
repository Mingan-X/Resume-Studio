import { Inject, Injectable } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { INFRA_CONFIG } from '../tokens.js';
import type { InfrastructureConfig } from '../config.js';
import { QDRANT_REQUEST_TIMEOUT_MS } from './request-budget.js';

@Injectable()
export class VectorService {
  readonly client: QdrantClient;

  constructor(@Inject(INFRA_CONFIG) config: InfrastructureConfig) {
    this.client = new QdrantClient({
      url: config.qdrantUrl, apiKey: config.qdrantApiKey,
      timeout: QDRANT_REQUEST_TIMEOUT_MS, maxConnections: 3,
    });
  }
}
