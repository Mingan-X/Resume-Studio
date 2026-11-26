import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import { TaskInvalidStateError, TaskNotFoundError } from '../../modules/tasks/task-errors.js';
import { budgetUsageSchema, taskCountsSchema, taskFailureCodeSchema } from '../../contracts/tasks.js';
import { taskResponseSchema, cancelTaskResponseSchema } from '../../contracts/task-api.js';
import { isRetryable } from '../consumer/failure.js';

const terminal = new Set(['SUCCEEDED','PARTIAL','FAILED','CANCELLED']);
const selection = { id: true, status: true, stage: true, cancelRequested: true,
  retryAt: true, errorCode: true, budgetUsage: true } as const;

@Injectable()
export class TaskQueryRepository {
  constructor(private readonly database: DatabaseService) {}

  async get(owner: string, id: string) {
    const ownerId = ownerIdSchema.parse(owner), taskId = z.uuid().parse(id).toLowerCase();
    return this.database.client.$transaction(async tx => {
      const where = { ownerId_id: { ownerId, id: taskId } };
      const analysis = await tx.analysisTask.findUnique({ where, select: { ...selection, reportId: true } });
      const index = await tx.jobIndexTask.findUnique({ where, select: selection });
      if (analysis && index) throw new Error('AMBIGUOUS_TASK_ID');
      const task = analysis ?? index;
      if (!task) throw new TaskNotFoundError();
      const taskType = analysis ? 'ANALYSIS' : 'JOB_INDEX';
      const latest = await tx.taskEvent.findFirst({ where: { ownerId, taskType, taskId }, orderBy: { seq: 'desc' }, select: { counts: true } });
      const counts = latest ? taskCountsSchema.parse(latest.counts) : null;
      const error = task.errorCode ? taskFailureCodeSchema.safeParse(task.errorCode) : null;
      const code = error?.success ? error.data : 'EXECUTION_FAILED';
      return taskResponseSchema.parse({ taskId, taskType, status: task.status, stage: task.stage,
        progress: { completed: counts?.completed ?? 0, total: counts?.planned ?? null },
        attempt: budgetUsageSchema.parse(task.budgetUsage).attempts, nextRetryAt: task.retryAt?.toISOString() ?? null,
        cancelRequested: task.cancelRequested, reportId: analysis?.reportId ?? null,
        error: task.errorCode ? { code, message: '任务执行未完成，请查看任务状态', retryable: task.status === 'RETRY_WAIT' && isRetryable(code) } : null,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async requestCancellation(owner: string, id: string) {
    const ownerId = ownerIdSchema.parse(owner), taskId = z.uuid().parse(id).toLowerCase();
    return this.database.client.$transaction(async tx => {
      // Both task types share one URL. Lock in a fixed order and fail closed on an ambiguous UUID.
      const schema = z.array(z.object({ status: z.string(), cancelRequested: z.boolean() })).max(1);
      const analysis = schema.parse(await tx.$queryRaw`SELECT status, cancel_requested AS "cancelRequested" FROM analysis_task
        WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid FOR UPDATE`)[0];
      const index = schema.parse(await tx.$queryRaw`SELECT status, cancel_requested AS "cancelRequested" FROM job_index_task
        WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid FOR UPDATE`)[0];
      if (analysis && index) throw new Error('AMBIGUOUS_TASK_ID');
      const task = analysis ?? index;
      if (!task) throw new TaskNotFoundError();
      if (terminal.has(task.status)) throw new TaskInvalidStateError();
      if (!task.cancelRequested) {
        const table = analysis ? Prisma.sql`analysis_task` : Prisma.sql`job_index_task`;
        await tx.$executeRaw(Prisma.sql`UPDATE ${table} SET cancel_requested=true, updated_at=clock_timestamp()
          WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid`);
      }
      return cancelTaskResponseSchema.parse({ taskId, cancelRequested: true });
    });
  }
}
