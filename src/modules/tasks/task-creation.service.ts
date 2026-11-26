import { Inject, Injectable } from '@nestjs/common';
import {
  idempotencyKeySchema, syntheticAnalysisInputSchema, syntheticJobIndexInputSchema,
} from '../../contracts/tasks.js';
import { IDENTITY, ownerIdSchema } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { TaskRepository } from '../../infrastructure/tasks/task.repository.js';

@Injectable()
export class TaskCreationService {
  constructor(
    @Inject(IDENTITY) private readonly identity: IdentityPort,
    private readonly tasks: TaskRepository,
  ) {}

  async createAnalysis(idempotencyKey: unknown, input: unknown) {
    const key = idempotencyKeySchema.parse(idempotencyKey);
    const parsed = syntheticAnalysisInputSchema.parse(input);
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    return this.tasks.createAnalysis(key, { ...parsed, ownerId });
  }

  async createJobIndex(idempotencyKey: unknown, input: unknown) {
    const key = idempotencyKeySchema.parse(idempotencyKey);
    const parsed = syntheticJobIndexInputSchema.parse(input);
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    return this.tasks.createJobIndex(key, { ...parsed, ownerId });
  }
}
