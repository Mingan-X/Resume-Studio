import { Controller, Get, Query } from '@nestjs/common';
import { healthQuerySchema } from '../../contracts/http.js';
import type { HealthQuery, HealthResponse } from '../../contracts/http.js';
import { ZodValidationPipe } from '../../infrastructure/http/zod-validation.pipe.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(@Query(new ZodValidationPipe(healthQuerySchema)) _query: HealthQuery): HealthResponse {
    return this.health.check();
  }
}
