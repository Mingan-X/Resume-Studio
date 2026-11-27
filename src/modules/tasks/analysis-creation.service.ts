import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY, ownerIdSchema } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { AnalysisRepository } from '../../infrastructure/tasks/analysis.repository.js';
import { createAnalysisResponseSchema } from '../../contracts/analyses.js';

export const ANALYSIS_CONFIGURATION = Symbol('ANALYSIS_CONFIGURATION');
@Injectable()
export class AnalysisCreationService {
  constructor(@Inject(IDENTITY) private readonly identity: IdentityPort, private readonly repository: AnalysisRepository,
    @Inject(ANALYSIS_CONFIGURATION) private readonly configuration: unknown) {}
  async create(key: unknown, request: unknown) {
    const taskId = await this.repository.create(ownerIdSchema.parse(await this.identity.getOwnerId()), key, request, this.configuration);
    return createAnalysisResponseSchema.parse({ taskId, statusUrl: `/api/v1/tasks/${taskId}` });
  }
}
