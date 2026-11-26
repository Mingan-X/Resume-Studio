import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY, ownerIdSchema } from '../identity/identity.module.js';
import type { IdentityPort } from '../identity/identity.module.js';
import { taskPathSchema } from '../../contracts/task-api.js';
import { TaskQueryRepository } from '../../infrastructure/tasks/task-query.repository.js';

@Injectable()
export class TaskQueryService {
  constructor(@Inject(IDENTITY) private readonly identity: IdentityPort, private readonly tasks: TaskQueryRepository) {}
  async get(id: string) {
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    return this.tasks.get(ownerId, taskPathSchema.parse({ taskId: id }).taskId);
  }
  async cancel(id: string) {
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    return this.tasks.requestCancellation(ownerId, taskPathSchema.parse({ taskId: id }).taskId);
  }
}
