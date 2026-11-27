import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY, ownerIdSchema } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { JobRepository } from '../../infrastructure/jobs/job.repository.js';
import { dimensionSchema, versionNameSchema } from '../../contracts/jobs.js';
import { rubricVersionSchema } from '../../contracts/rubric.js';

@Injectable()
export class RubricService {
  constructor(@Inject(IDENTITY) private readonly identity: IdentityPort, private readonly repository: JobRepository) {}
  async import(input: unknown, allowSynthetic = false) {
    const content = rubricVersionSchema.parse(input), ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    if (content.provenance === 'SYNTHETIC' && !allowSynthetic) throw new Error('TEST_RUBRIC_NOT_ALLOWED');
    return this.repository.importRubric(ownerId, content);
  }
  async load(version: unknown, allowSynthetic = false) {
    const value = await this.repository.findRubric(ownerIdSchema.parse(await this.identity.getOwnerId()), versionNameSchema.parse(version));
    if (!value) throw new Error('RUBRIC_NOT_FOUND');
    if (value.content.provenance === 'SYNTHETIC' && !allowSynthetic) throw new Error('TEST_RUBRIC_NOT_ALLOWED');
    return value;
  }
  async dimension(version: unknown, dimension: unknown, allowSynthetic = false) {
    const id = dimensionSchema.parse(dimension), rubric = await this.load(version, allowSynthetic);
    const value = rubric.content.dimensions.find(item => item.dimension === id);
    if (!value) throw new Error('RUBRIC_INCOMPLETE');
    return { version: rubric.content.version, contentHash: rubric.contentHash, reviewStatus: rubric.content.reviewStatus,
      dimension: value.dimension, levels: [...value.levels].sort((a, b) => a.level - b.level) };
  }
}
