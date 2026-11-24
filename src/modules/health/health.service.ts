import { Injectable } from '@nestjs/common';
import { healthResponseSchema } from '../../contracts/http.js';
import type { HealthResponse } from '../../contracts/http.js';
import { ConfigService } from '../config/config.module.js';

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService) {}

  check(): HealthResponse {
    // Liveness only; this endpoint does not check database, queue or model readiness.
    return healthResponseSchema.parse({
      status: 'ok', service: 'api', environment: this.config.values.APP_ENV,
    });
  }
}
