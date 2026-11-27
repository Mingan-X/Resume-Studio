import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { IDENTITY, ownerIdSchema } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { createJobDraftSchema, editJobDraftSchema } from '../../contracts/job-drafts.js';
import { dimensionIds, jobVersionSchema } from '../../contracts/jobs.js';
import { JobRepository } from '../../infrastructure/jobs/job.repository.js';
import { jdDocument } from './evidence.js';

@Injectable()
export class JobDraftService {
  constructor(@Inject(IDENTITY) private readonly identity: IdentityPort, private readonly jobs: JobRepository) {}

  async create(input: unknown) {
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId()), value = createJobDraftSchema.parse(input);
    const id = randomUUID();
    return this.jobs.createDraft(ownerId, jobVersionSchema.parse({ schemaVersion: 1, id, ownerId, jobId: randomUUID(), version: 1,
      title: value.title, city: value.city, level: value.level, skills: value.skills, document: jdDocument(id, value.body),
      requirements: [], dimensionWeights: dimensionIds.map(dimension => ({ dimension, weight: 1 })),
      hardRequirementsConfirmed: false, weightsConfirmed: false, status: 'DRAFT', contentHash: null,
      publishedAt: null, indexStatus: 'NOT_REQUESTED', createdAt: new Date().toISOString(),
    }));
  }
  async edit(version: unknown, input: unknown) {
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    return this.jobs.editDraft(ownerId, z.uuid().parse(version), editJobDraftSchema.parse(input));
  }
}
