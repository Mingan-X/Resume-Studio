import { Controller, Get, Query, ServiceUnavailableException } from '@nestjs/common';
import { healthQuerySchema, readinessResponseSchema } from '../../contracts/http.js';
import { ZodValidationPipe } from '../../infrastructure/http/zod-validation.pipe.js';
import { ReadinessService } from './readiness.service.js';

@Controller('ready')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}
  @Get() async check(@Query(new ZodValidationPipe(healthQuerySchema)) _query: unknown) {
    if (!await this.readiness.check()) throw new ServiceUnavailableException();
    return readinessResponseSchema.parse({ status: 'ready' });
  }
}
