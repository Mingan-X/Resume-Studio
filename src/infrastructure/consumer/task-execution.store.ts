import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseService } from '../database/database.service.js';
import {
  analysisInputSnapshotSchema, jobIndexInputSnapshotSchema, budgetUsageSchema, taskCountsSchema, taskDispatchSchema,
} from '../../contracts/tasks.js';
import type { TaskType } from '../../contracts/tasks.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { consumerName, syntheticCompletionSchema, ExecutionLeaseLostError } from './contracts.js';
import type { ClaimResult, ExecutionClaim } from './contracts.js';
import type { ConsumerConfig } from './config.js';

const table = (type: TaskType) => type === 'analysis' ? Prisma.sql`analysis_task` : Prisma.sql`job_index_task`;
const dbType = (type: TaskType): 'ANALYSIS' | 'JOB_INDEX' => type === 'analysis' ? 'ANALYSIS' : 'JOB_INDEX';
const rowSchema = z.object({ id: z.uuid(), ownerId: z.uuid(), status: z.string(), generation: z.int(),
  fenceToken: z.bigint(), leaseOwner: z.uuid().nullable(), leaseUntil: z.date().nullable(),
  cancelRequested: z.boolean(), inputSnapshot: z.unknown(), budgetUsage: z.unknown() });
const timeRows = z.array(z.object({ now: z.date() })).length(1);
const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);

async function databaseNow(tx: Prisma.TransactionClient) {
  return timeRows.parse(await tx.$queryRaw`SELECT clock_timestamp() AS now`)[0]!.now;
}

export class TaskExecutionStore {
  constructor(private readonly database: DatabaseService, private readonly config: ConsumerConfig) {}

  async claim(owner: string, input: unknown): Promise<ClaimResult> {
    const ownerId = ownerIdSchema.parse(owner), message = taskDispatchSchema.parse(input);
    const name = consumerName(message.taskType), type = dbType(message.taskType);
    return this.database.client.$transaction(async tx => {
      const task = z.array(rowSchema).max(1).parse(await tx.$queryRaw(Prisma.sql`
        SELECT id, owner_id AS "ownerId", status, generation, fence_token AS "fenceToken",
          lease_owner AS "leaseOwner", lease_until AS "leaseUntil", cancel_requested AS "cancelRequested",
          input_snapshot AS "inputSnapshot", budget_usage AS "budgetUsage"
        FROM ${table(message.taskType)} WHERE owner_id = ${ownerId}::uuid AND id = ${message.taskId}::uuid FOR UPDATE`))[0];
      if (!task) throw new Error('TASK_NOT_AVAILABLE');
      const snapshot = message.taskType === 'analysis'
        ? analysisInputSnapshotSchema.parse(task.inputSnapshot) : jobIndexInputSnapshotSchema.parse(task.inputSnapshot);
      if (snapshot.ownerId !== ownerId) throw new Error('TASK_OWNER_MISMATCH');
      const usage = budgetUsageSchema.parse(task.budgetUsage);
      const receiptKey = { consumerName_messageId: { consumerName: name, messageId: message.messageId }, ownerId };
      const receipt = await tx.consumerReceipt.findUnique({ where: receiptKey });
      if (receipt && (receipt.taskId !== message.taskId || receipt.taskType !== type || receipt.generation !== message.dispatchGeneration)) {
        throw new Error('MESSAGE_ID_REUSED');
      }
      if (message.dispatchGeneration > task.generation) throw new Error('FUTURE_GENERATION');
      const now = await databaseNow(tx);
      const reference = { ownerId, taskType: type, taskId: task.id,
        analysisTaskId: type === 'ANALYSIS' ? task.id : null, jobIndexTaskId: type === 'JOB_INDEX' ? task.id : null };
      if (terminal.has(task.status) || message.dispatchGeneration < task.generation) {
        // Even terminal/stale delivery requires a writable DB before ACK. Persist reliable disposition.
        if (receipt) await tx.consumerReceipt.update({ where: { id: receipt.id, ownerId },
          data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
        else await tx.consumerReceipt.create({ data: { ...reference, id: randomUUID(), consumerName: name,
          messageId: message.messageId, generation: message.dispatchGeneration, status: 'DONE', processedAt: now } });
        return { kind: 'ack' };
      }
      if (receipt?.status === 'DONE') throw new Error('RECEIPT_TASK_STATE_MISMATCH');
      if (task.cancelRequested || (task.status === 'RUNNING' && task.leaseUntil && task.leaseUntil > now)) return { kind: 'deferred' };
      if (!['QUEUED', 'RETRY_WAIT', 'RUNNING'].includes(task.status)) throw new Error('INVALID_TASK_STATE');
      const first = await tx.taskAttempt.findFirst({ where: { ownerId, taskType: type, taskId: task.id }, orderBy: { startedAt: 'asc' } });
      const deadline = new Date(Math.min((first?.startedAt ?? now).getTime() + snapshot.budget.maxDurationMs,
        now.getTime() + this.config.executionTimeoutMs));
      if (usage.attempts >= snapshot.budget.maxAttempts || deadline <= now) throw new Error('TASK_BUDGET_EXHAUSTED');
      if (task.leaseOwner) {
        const previous = await tx.taskAttempt.findFirst({ where: { ownerId, attemptId: task.leaseOwner, taskId: task.id, taskType: type } });
        if (previous && !previous.endedAt) {
          await tx.taskAttempt.update({ where: { attemptId: previous.attemptId, ownerId }, data: { endedAt: now, errorClass: 'LEASE_EXPIRED' } });
          usage.elapsedMs += Math.max(0, now.getTime() - previous.startedAt.getTime());
        }
      }
      const attemptId = randomUUID(), fenceToken = task.fenceToken + 1n;
      const leaseUntil = new Date(Math.min(now.getTime() + this.config.leaseMs, deadline.getTime()));
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE ${table(message.taskType)} SET status = 'RUNNING', stage = 'SYNTHETIC_RUNNING',
          fence_token = fence_token + 1, lease_owner = ${attemptId}::uuid, lease_until = ${leaseUntil},
          heartbeat_at = ${now}, updated_at = ${now}, budget_usage = ${JSON.stringify(budgetUsageSchema.parse({ ...usage, attempts: usage.attempts + 1 }))}::jsonb
        WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid AND generation = ${message.dispatchGeneration}
          AND fence_token = ${task.fenceToken} AND cancel_requested = false
          AND (status IN ('QUEUED', 'RETRY_WAIT') OR (status = 'RUNNING' AND (lease_until IS NULL OR lease_until <= ${now})))`);
      if (updated !== 1) throw new ExecutionLeaseLostError();
      await tx.taskAttempt.create({ data: { ...reference, attemptId, generation: message.dispatchGeneration,
        fenceToken, startedAt: now, currency: snapshot.budget.currency } });
      if (receipt) await tx.consumerReceipt.update({ where: { id: receipt.id, ownerId },
        data: { leaseOwner: attemptId, leaseUntil } });
      else await tx.consumerReceipt.create({ data: { ...reference, id: randomUUID(), consumerName: name,
        messageId: message.messageId, generation: message.dispatchGeneration, leaseOwner: attemptId, leaseUntil } });
      return { kind: 'acquired', claim: { ownerId, consumerName: name, message, attemptId, fenceToken, startedAt: now, deadline, snapshot } };
    });
  }

  async heartbeat(claim: ExecutionClaim): Promise<void> {
    await this.database.client.$transaction(async tx => {
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE ${table(claim.message.taskType)} SET heartbeat_at = clock_timestamp(),
          lease_until = LEAST(clock_timestamp() + ${this.config.leaseMs} * interval '1 millisecond', ${claim.deadline}),
          updated_at = clock_timestamp()
        WHERE owner_id = ${claim.ownerId}::uuid AND id = ${claim.message.taskId}::uuid
          AND generation = ${claim.message.dispatchGeneration} AND fence_token = ${claim.fenceToken}
          AND lease_owner = ${claim.attemptId}::uuid AND lease_until > clock_timestamp()
          AND status = 'RUNNING' AND cancel_requested = false AND ${claim.deadline} > clock_timestamp()`);
      if (changed !== 1) throw new ExecutionLeaseLostError();
      const receipt = await tx.$executeRaw(Prisma.sql`
        UPDATE consumer_receipt SET lease_until = task.lease_until FROM ${table(claim.message.taskType)} AS task
        WHERE consumer_receipt.owner_id = ${claim.ownerId}::uuid AND consumer_name = ${claim.consumerName}
          AND message_id = ${claim.message.messageId}::uuid AND task_id = ${claim.message.taskId}::uuid
          AND task_type = ${dbType(claim.message.taskType)}::"TaskType" AND consumer_receipt.generation = ${claim.message.dispatchGeneration}
          AND consumer_receipt.lease_owner = ${claim.attemptId}::uuid AND consumer_receipt.status = 'RUNNING'
          AND task.id = consumer_receipt.task_id AND task.owner_id = consumer_receipt.owner_id`);
      if (receipt !== 1) throw new ExecutionLeaseLostError();
    });
  }

  async complete(claim: ExecutionClaim, output: unknown): Promise<void> {
    const result = syntheticCompletionSchema.parse(output);
    if (result.inputHash !== requestHash(claim.snapshot)) throw new Error('SYNTHETIC_RESULT_INPUT_MISMATCH');
    await this.database.client.$transaction(async tx => {
      // The conditional task write also holds the row lock across output/attempt/receipt writes.
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE ${table(claim.message.taskType)} SET status = 'SUCCEEDED', stage = 'SYNTHETIC_COMPLETED',
          lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp(), error_code = NULL,
          budget_usage = jsonb_set(budget_usage, '{elapsedMs}',
            to_jsonb((budget_usage->>'elapsedMs')::bigint + GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - ${claim.startedAt}::timestamp)) * 1000)::bigint)))
        WHERE owner_id = ${claim.ownerId}::uuid AND id = ${claim.message.taskId}::uuid
          AND generation = ${claim.message.dispatchGeneration} AND fence_token = ${claim.fenceToken}
          AND lease_owner = ${claim.attemptId}::uuid AND lease_until > clock_timestamp()
          AND status = 'RUNNING' AND cancel_requested = false AND ${claim.deadline} > clock_timestamp()`);
      if (changed !== 1) throw new ExecutionLeaseLostError();
      const type = dbType(claim.message.taskType), now = await databaseNow(tx);
      const previous = await tx.taskEvent.findFirst({ where: { ownerId: claim.ownerId, taskType: type, taskId: claim.message.taskId }, orderBy: { seq: 'desc' } });
      await tx.taskEvent.create({ data: { id: randomUUID(), ownerId: claim.ownerId, taskType: type, taskId: claim.message.taskId,
        analysisTaskId: type === 'ANALYSIS' ? claim.message.taskId : null, jobIndexTaskId: type === 'JOB_INDEX' ? claim.message.taskId : null,
        seq: (previous?.seq ?? 0) + 1, stage: 'SYNTHETIC_COMPLETED', safeMessage: 'Synthetic task completed',
        counts: taskCountsSchema.parse({ schemaVersion: 1, planned: 1, completed: result.completedUnits, failed: 0 }) } });
      const attempt = await tx.taskAttempt.updateMany({ where: { ownerId: claim.ownerId, attemptId: claim.attemptId,
        taskType: type, taskId: claim.message.taskId, fenceToken: claim.fenceToken, endedAt: null }, data: { endedAt: now } });
      const receipt = await tx.consumerReceipt.updateMany({ where: { ownerId: claim.ownerId, consumerName: claim.consumerName,
        messageId: claim.message.messageId, taskId: claim.message.taskId, taskType: type, generation: claim.message.dispatchGeneration,
        leaseOwner: claim.attemptId, status: 'RUNNING' }, data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
      if (attempt.count !== 1 || receipt.count !== 1) throw new ExecutionLeaseLostError();
    });
  }
}
