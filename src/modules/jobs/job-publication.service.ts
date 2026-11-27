import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { IDENTITY, ownerIdSchema } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { JobPublicationRepository } from '../../infrastructure/jobs/publication.repository.js';
import type { JobIndexTarget } from '../../contracts/job-publication.js';
import { jobConfirmationSchema } from '../../contracts/job-publication.js';
import { idempotencyKeySchema } from '../../contracts/tasks.js';

export const JOB_INDEX_TARGET = Symbol('JOB_INDEX_TARGET');
@Injectable()
export class JobPublicationService {
  constructor(@Inject(IDENTITY) private readonly identity: IdentityPort, private readonly publications: JobPublicationRepository,
    @Inject(JOB_INDEX_TARGET) private readonly target: JobIndexTarget | undefined) {}
  async confirm(version: unknown, input: unknown) {
    return this.publications.confirm(ownerIdSchema.parse(await this.identity.getOwnerId()), z.uuid().parse(version), jobConfirmationSchema.parse(input));
  }
  async publish(version: unknown, key: unknown) {
    return this.publications.publish(ownerIdSchema.parse(await this.identity.getOwnerId()), z.uuid().parse(version), idempotencyKeySchema.parse(key), this.target);
  }
}
