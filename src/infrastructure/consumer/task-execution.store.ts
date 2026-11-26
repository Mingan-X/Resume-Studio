import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import type { TransactionDatabase } from '../database/transaction-port.js';
import {
  analysisInputSnapshotSchema, jobIndexInputSnapshotSchema, budgetUsageSchema, taskCountsSchema, taskDispatchSchema,
  deadMessageSchema, usageReservationSchema,
} from '../../contracts/tasks.js';
import type { TaskType } from '../../contracts/tasks.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { consumerName, syntheticCompletionSchema, syntheticNodeOutputSchema, ExecutionLeaseLostError, RejectedTaskDelivery } from './contracts.js';
import type { SyntheticNodeOutput } from './contracts.js';
import { TaskFailure, isRetryable, executionRetryDelay } from './failure.js';
import type { TaskFailureCode } from './failure.js';
import type { ClaimResult, ExecutionClaim } from './contracts.js';
import type { ConsumerConfig } from './config.js';
import { executionLockKey } from './task-execution.lock.js';
import type { ReconciliationConfig } from '../reconciliation/config.js';

const table = (type: TaskType) => type === 'analysis' ? Prisma.sql`analysis_task` : Prisma.sql`job_index_task`;
const dbType = (type: TaskType): 'ANALYSIS' | 'JOB_INDEX' => type === 'analysis' ? 'ANALYSIS' : 'JOB_INDEX';
const rowSchema = z.object({ id: z.uuid(), ownerId: z.uuid(), status: z.string(), generation: z.int(),
  fenceToken: z.bigint(), leaseOwner: z.uuid().nullable(), leaseUntil: z.date().nullable(),
  retryAt: z.date().nullable(), recoveryCount: z.int().nonnegative(), updatedAt: z.date(),
  graphThreadId: z.uuid().nullable(), graphGeneration: z.int().positive().nullable(),
  cancelRequested: z.boolean(), inputSnapshot: z.unknown(), budgetUsage: z.unknown() });
const timeRows = z.array(z.object({ now: z.date() })).length(1);
const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);

async function databaseNow(tx: Prisma.TransactionClient) {
  return timeRows.parse(await tx.$queryRaw`SELECT clock_timestamp() AS now`)[0]!.now;
}

async function lockTask(tx: Prisma.TransactionClient, ownerId: string, message: Pick<ExecutionClaim['message'], 'taskId' | 'taskType'>, skipLocked = false) {
  return z.array(rowSchema).max(1).parse(await tx.$queryRaw(Prisma.sql`
    SELECT id, owner_id AS "ownerId", status, generation, fence_token AS "fenceToken", retry_at AS "retryAt",
      lease_owner AS "leaseOwner", lease_until AS "leaseUntil", cancel_requested AS "cancelRequested",
      input_snapshot AS "inputSnapshot", budget_usage AS "budgetUsage", recovery_count AS "recoveryCount", updated_at AS "updatedAt",
      ${message.taskType === 'analysis' ? Prisma.sql`active_graph_thread_id AS "graphThreadId", graph_generation AS "graphGeneration"`
        : Prisma.sql`NULL::uuid AS "graphThreadId", NULL::int AS "graphGeneration"`}
    FROM ${table(message.taskType)} WHERE owner_id = ${ownerId}::uuid AND id = ${message.taskId}::uuid
      FOR UPDATE ${skipLocked ? Prisma.sql`SKIP LOCKED` : Prisma.empty}`))[0];
}

// Caller holds the task row lock, validates execution authority, and passes validated accumulated usage.
async function finishFailure(tx: Prisma.TransactionClient, ownerId: string, message: ExecutionClaim['message'],
  task: z.infer<typeof rowSchema>, now: Date, code: TaskFailureCode, retryAt: Date | null,
  usage: z.infer<typeof budgetUsageSchema>, attemptId: string | null, originalMessageId: string | null = message.messageId) {
  const status = retryAt ? 'RETRY_WAIT' : 'FAILED', type = dbType(message.taskType);
  const generation = task.generation + (retryAt ? 1 : 0);
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE ${table(message.taskType)} SET status = ${status}::${message.taskType === 'analysis' ? Prisma.sql`"AnalysisTaskStatus"` : Prisma.sql`"JobIndexTaskStatus"`},
      stage = ${status}, retry_at = ${retryAt}, generation = ${generation}, error_code = ${code},
      lease_owner = NULL, lease_until = NULL, updated_at = ${now}, budget_usage = ${JSON.stringify(budgetUsageSchema.parse(usage))}::jsonb
    WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid AND fence_token = ${task.fenceToken}
      AND generation = ${message.dispatchGeneration} AND status IN ('QUEUED','RUNNING','RETRY_WAIT') AND cancel_requested = false`);
  if (changed !== 1) throw new ExecutionLeaseLostError();
  if (attemptId) await tx.taskAttempt.updateMany({ where: { ownerId, attemptId, taskId: task.id, taskType: type, endedAt: null },
    data: { endedAt: now, errorClass: code } });
  const reference = { ownerId, taskType: type, taskId: task.id,
    analysisTaskId: type === 'ANALYSIS' ? task.id : null, jobIndexTaskId: type === 'JOB_INDEX' ? task.id : null };
  const name = consumerName(message.taskType);
  const receipt = await tx.consumerReceipt.findUnique({ where: { consumerName_messageId: { consumerName: name, messageId: message.messageId }, ownerId } });
  if (receipt) await tx.consumerReceipt.update({ where: { ownerId, id: receipt.id }, data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
  else if (originalMessageId !== null) await tx.consumerReceipt.create({ data: { ...reference, id: randomUUID(), consumerName: name, messageId: message.messageId,
    generation: message.dispatchGeneration, status: 'DONE', processedAt: now } });
  const previous = await tx.taskEvent.findFirst({ where: { ownerId, taskType: type, taskId: task.id }, orderBy: { seq: 'desc' } });
  await tx.taskEvent.create({ data: { ...reference, id: randomUUID(), seq: (previous?.seq ?? 0) + 1, stage: status,
    safeMessage: retryAt ? 'Task retry scheduled' : 'Task failed',
    counts: taskCountsSchema.parse({ schemaVersion: 1, planned: 1, completed: 0, failed: retryAt ? 0 : 1 }) } });
  const eventId = randomUUID();
  const payload = retryAt ? taskDispatchSchema.parse({ ...message, messageId: eventId, dispatchGeneration: generation, occurredAt: now.toISOString() })
    : deadMessageSchema.parse({ schemaVersion: 1, kind: 'dead', messageId: eventId, taskType: message.taskType,
      occurredAt: now.toISOString(), originalMessageId, errorCode: code,
      source: { kind: 'task', taskId: task.id, dispatchGeneration: task.generation } });
  await tx.outboxEvent.create({ data: { eventId, ownerId,
    aggregateType: type === 'ANALYSIS' ? 'AnalysisTask' : 'JobIndexTask', aggregateId: task.id,
    eventType: `${type === 'ANALYSIS' ? 'analysis' : 'job.index'}.${retryAt ? 'requested' : 'dead'}.v1`,
    payloadVersion: 1, payload, availableAt: retryAt ?? now } });
}

// Caller owns the execution lock (or is its settled holder) and the task row lock.
// Cancellation fences business writes; it does not assert that an unknown old process has exited.
async function finishCancellation(tx: Prisma.TransactionClient, ownerId: string, taskType: TaskType,
  task: z.infer<typeof rowSchema>, now: Date) {
  const type = dbType(taskType), reference = { ownerId, taskType: type, taskId: task.id };
  const usage = budgetUsageSchema.parse(task.budgetUsage);
  if (task.leaseOwner) {
    const attempt = await tx.taskAttempt.findFirst({ where: { ...reference, attemptId: task.leaseOwner, endedAt: null } });
    if (attempt) usage.elapsedMs += Math.max(0, now.getTime() - attempt.startedAt.getTime());
  }
  const changed = await tx.$executeRaw(Prisma.sql`UPDATE ${table(taskType)} SET status='CANCELLED', stage='CANCELLED',
    fence_token=fence_token+1, lease_owner=NULL, lease_until=NULL, heartbeat_at=NULL, retry_at=NULL,
    error_code=NULL, updated_at=${now}, budget_usage=${JSON.stringify(budgetUsageSchema.parse(usage))}::jsonb
    WHERE owner_id=${ownerId}::uuid AND id=${task.id}::uuid AND cancel_requested=true
      AND generation=${task.generation} AND fence_token=${task.fenceToken} AND status IN ('QUEUED','RETRY_WAIT','RUNNING')`);
  if (changed !== 1) throw new ExecutionLeaseLostError();
  await tx.taskAttempt.updateMany({ where: { ...reference, endedAt: null }, data: { endedAt: now, errorClass: 'CANCELLED' } });
  await tx.consumerReceipt.updateMany({ where: { ...reference, status: 'RUNNING', generation: { lte: task.generation } },
    data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
  const previous = await tx.taskEvent.findFirst({ where: reference, orderBy: { seq: 'desc' } });
  await tx.taskEvent.create({ data: { ...reference, id: randomUUID(), seq: (previous?.seq ?? 0) + 1,
    analysisTaskId: type === 'ANALYSIS' ? task.id : null, jobIndexTaskId: type === 'JOB_INDEX' ? task.id : null,
    stage: 'CANCELLED', safeMessage: 'Task cancelled',
    counts: taskCountsSchema.parse(previous?.counts ?? { schemaVersion: 1, planned: 1, completed: 0, failed: 0 }) } });
}

export class TaskExecutionStore {
  constructor(private readonly database: TransactionDatabase, private readonly config: ConsumerConfig) {}

  async reconcile(owner: string, taskType: TaskType, id: string, config: ReconciliationConfig) {
    const ownerId = ownerIdSchema.parse(owner), taskId = z.uuid().parse(id).toLowerCase();
    return this.database.client.$transaction(async tx => {
      const lock = z.array(z.object({ acquired: z.boolean() })).length(1).parse(await tx.$queryRaw`
        SELECT pg_try_advisory_xact_lock(${executionLockKey(ownerId, taskType, taskId)}::bigint) AS acquired`)[0]!;
      if (!lock.acquired) return 'lock-held';
      const task = await lockTask(tx, ownerId, { taskType, taskId }, true), now = await databaseNow(tx);
      if (!task || terminal.has(task.status)) return 'skipped';
      if (task.cancelRequested) { await finishCancellation(tx, ownerId, taskType, task, now); return 'cancelled'; }
      const expired = task.status === 'RUNNING' && (!task.leaseUntil || task.leaseUntil <= now);
      if (task.status === 'RUNNING' && !expired) return 'skipped';
      if (!expired && (task.updatedAt.getTime() + config.staleMs > now.getTime() || (task.retryAt && task.retryAt > now))) return 'skipped';
      const snapshot = taskType === 'analysis' ? analysisInputSnapshotSchema.parse(task.inputSnapshot) : jobIndexInputSnapshotSchema.parse(task.inputSnapshot);
      if (snapshot.ownerId !== ownerId) throw new Error('TASK_OWNER_MISMATCH');
      const usage = budgetUsageSchema.parse(task.budgetUsage), type = dbType(taskType);
      const first = await tx.taskAttempt.findFirst({ where: { ownerId, taskId, taskType: type }, orderBy: { startedAt: 'asc' } });
      const exhausted = usage.attempts >= snapshot.budget.maxAttempts || task.recoveryCount >= config.maxRecoveries;
      const timedOut = first !== null && first.startedAt.getTime() + snapshot.budget.maxDurationMs <= now.getTime();
      const reference = { ownerId, taskId, taskType: type };
      const currentEvent = await tx.outboxEvent.findFirst({ where: { ownerId, aggregateId: taskId,
        aggregateType: type === 'ANALYSIS' ? 'AnalysisTask' : 'JobIndexTask',
        eventType: type === 'ANALYSIS' ? 'analysis.requested.v1' : 'job.index.requested.v1',
        payload: { path: ['dispatchGeneration'], equals: task.generation } }, orderBy: [{ createdAt: 'desc' }, { eventId: 'desc' }] });
      if (currentEvent) {
        const payload = taskDispatchSchema.parse(currentEvent.payload);
        if (payload.taskType !== taskType || payload.taskId !== taskId || payload.messageId !== currentEvent.eventId
          || currentEvent.payloadVersion !== 1) throw new Error('INVALID_RECOVERY_EVENT');
      }
      // A pending or exhausted delivery is owned by the publisher, not a new unlimited dispatch cycle.
      if (!expired && usage.attempts < snapshot.budget.maxAttempts && !timedOut && currentEvent) {
        if (currentEvent.failedAt) return 'delivery-failed';
        if (!currentEvent.publishedAt) return 'pending';
        if (currentEvent.publishedAt.getTime() + config.staleMs > now.getTime()) return 'skipped';
      }
      const receipt = await tx.consumerReceipt.findFirst({ where: { ...reference, generation: task.generation,
        ...(task.leaseOwner ? { leaseOwner: task.leaseOwner } : {}) }, orderBy: { createdAt: 'desc' } });
      const original = taskDispatchSchema.parse({ schemaVersion: 1, messageId: receipt?.messageId ?? currentEvent?.eventId ?? randomUUID(),
        taskType, taskId, dispatchGeneration: task.generation, occurredAt: now.toISOString() });
      if (task.leaseOwner) {
        const attempt = await tx.taskAttempt.findFirst({ where: { ...reference, attemptId: task.leaseOwner, endedAt: null } });
        if (attempt) usage.elapsedMs += Math.max(0, now.getTime() - attempt.startedAt.getTime());
      }
      if (exhausted || timedOut) {
        await finishFailure(tx, ownerId, original, task, now, timedOut ? 'DEADLINE_EXCEEDED' : 'BUDGET_EXHAUSTED', null, usage, task.leaseOwner,
          receipt?.messageId ?? currentEvent?.eventId ?? null);
        // Any other delivery for the same superseded execution is also durably terminal.
        await tx.consumerReceipt.updateMany({ where: { ...reference, generation: task.generation, status: 'RUNNING' },
          data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
        return 'failed';
      }
      const generation = task.generation + 1, eventId = randomUUID();
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE ${table(taskType)} SET status = 'QUEUED', stage = 'RECOVERY_QUEUED', generation = ${generation},
          fence_token = fence_token + 1, recovery_count = recovery_count + 1, lease_owner = NULL, lease_until = NULL,
          heartbeat_at = NULL, retry_at = NULL, updated_at = ${now}, budget_usage = ${JSON.stringify(budgetUsageSchema.parse(usage))}::jsonb
        WHERE owner_id = ${ownerId}::uuid AND id = ${taskId}::uuid AND generation = ${task.generation}
          AND fence_token = ${task.fenceToken} AND status IN ('QUEUED','RETRY_WAIT','RUNNING') AND cancel_requested = false`);
      if (changed !== 1) throw new ExecutionLeaseLostError();
      if (task.leaseOwner) await tx.taskAttempt.updateMany({ where: { ...reference, attemptId: task.leaseOwner, endedAt: null },
        data: { endedAt: now, errorClass: 'LEASE_EXPIRED' } });
      await tx.consumerReceipt.updateMany({ where: { ...reference, generation: task.generation, status: 'RUNNING' },
        data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
      await tx.outboxEvent.create({ data: { ownerId, eventId, aggregateId: taskId,
        aggregateType: type === 'ANALYSIS' ? 'AnalysisTask' : 'JobIndexTask', eventType: `${type === 'ANALYSIS' ? 'analysis' : 'job.index'}.requested.v1`,
        payloadVersion: 1, payload: taskDispatchSchema.parse({ ...original, messageId: eventId, dispatchGeneration: generation, occurredAt: now.toISOString() }) } });
      const previous = await tx.taskEvent.findFirst({ where: reference, orderBy: { seq: 'desc' } });
      await tx.taskEvent.create({ data: { ...reference, id: randomUUID(), seq: (previous?.seq ?? 0) + 1,
        analysisTaskId: type === 'ANALYSIS' ? taskId : null, jobIndexTaskId: type === 'JOB_INDEX' ? taskId : null,
        stage: 'RECOVERY_QUEUED', safeMessage: 'Task recovery scheduled',
        counts: taskCountsSchema.parse({ schemaVersion: 1, planned: 1, completed: 0, failed: 0 }) } });
      return 'recovered';
    });
  }

  async claim(owner: string, input: unknown): Promise<ClaimResult> {
    const ownerId = ownerIdSchema.parse(owner), message = taskDispatchSchema.parse(input);
    const name = consumerName(message.taskType), type = dbType(message.taskType);
    return this.database.client.$transaction(async tx => {
      const task = await lockTask(tx, ownerId, message);
      if (!task) throw new RejectedTaskDelivery('TASK_NOT_AVAILABLE');
      const snapshot = message.taskType === 'analysis'
        ? analysisInputSnapshotSchema.parse(task.inputSnapshot) : jobIndexInputSnapshotSchema.parse(task.inputSnapshot);
      if (snapshot.ownerId !== ownerId) throw new Error('TASK_OWNER_MISMATCH');
      const usage = budgetUsageSchema.parse(task.budgetUsage);
      const receiptKey = { consumerName_messageId: { consumerName: name, messageId: message.messageId }, ownerId };
      const receipt = await tx.consumerReceipt.findUnique({ where: receiptKey });
      if (receipt && (receipt.taskId !== message.taskId || receipt.taskType !== type || receipt.generation !== message.dispatchGeneration)) {
        throw new RejectedTaskDelivery('MESSAGE_ID_REUSED');
      }
      if (message.dispatchGeneration > task.generation) throw new RejectedTaskDelivery('FUTURE_GENERATION');
      const now = await databaseNow(tx);
      const reference = { ownerId, taskType: type, taskId: task.id,
        analysisTaskId: type === 'ANALYSIS' ? task.id : null, jobIndexTaskId: type === 'JOB_INDEX' ? task.id : null };
      if (task.cancelRequested && !terminal.has(task.status)) {
        await finishCancellation(tx, ownerId, message.taskType, task, now);
        task.status = 'CANCELLED';
      }
      if (terminal.has(task.status) || message.dispatchGeneration < task.generation) {
        // Even terminal/stale delivery requires a writable DB before ACK. Persist reliable disposition.
        if (receipt) await tx.consumerReceipt.update({ where: { id: receipt.id, ownerId },
          data: { status: 'DONE', processedAt: now, leaseOwner: null, leaseUntil: null } });
        else await tx.consumerReceipt.create({ data: { ...reference, id: randomUUID(), consumerName: name,
          messageId: message.messageId, generation: message.dispatchGeneration, status: 'DONE', processedAt: now } });
        return { kind: 'ack' };
      }
      if (receipt?.status === 'DONE') throw new Error('RECEIPT_TASK_STATE_MISMATCH');
      if (task.status === 'RUNNING' && task.leaseUntil && task.leaseUntil > now) return { kind: 'deferred' };
      if (!['QUEUED', 'RETRY_WAIT', 'RUNNING'].includes(task.status)) throw new Error('INVALID_TASK_STATE');
      const first = await tx.taskAttempt.findFirst({ where: { ownerId, taskType: type, taskId: task.id }, orderBy: { startedAt: 'asc' } });
      const deadline = new Date(Math.min((first?.startedAt ?? now).getTime() + snapshot.budget.maxDurationMs,
        now.getTime() + this.config.executionTimeoutMs));
      if (usage.attempts >= snapshot.budget.maxAttempts || deadline <= now) {
        if (task.leaseOwner) {
          const previous = await tx.taskAttempt.findFirst({ where: { ownerId, attemptId: task.leaseOwner, taskId: task.id, taskType: type, endedAt: null } });
          if (previous) usage.elapsedMs += Math.max(0, now.getTime() - previous.startedAt.getTime());
        }
        await finishFailure(tx, ownerId, message, task, now, deadline <= now ? 'DEADLINE_EXCEEDED' : 'BUDGET_EXHAUSTED', null, usage, task.leaseOwner);
        return { kind: 'ack' };
      }
      if (task.retryAt && task.retryAt > now) return { kind: 'deferred' };
      if (task.leaseOwner) {
        const previous = await tx.taskAttempt.findFirst({ where: { ownerId, attemptId: task.leaseOwner, taskId: task.id, taskType: type } });
        if (previous && !previous.endedAt) {
          await tx.taskAttempt.update({ where: { attemptId: previous.attemptId, ownerId }, data: { endedAt: now, errorClass: 'LEASE_EXPIRED' } });
          usage.elapsedMs += Math.max(0, now.getTime() - previous.startedAt.getTime());
        }
      }
      const attemptId = randomUUID(), fenceToken = task.fenceToken + 1n;
      const lastAttempt = await tx.taskAttempt.findFirst({ where: { ownerId, taskType: type, taskId: task.id }, orderBy: [{ startedAt: 'desc' }, { fenceToken: 'desc' }] });
      const switchThread = message.taskType === 'analysis' && lastAttempt !== null && lastAttempt.executionStoppedAt === null;
      const graph = message.taskType === 'analysis' ? {
        threadId: switchThread ? randomUUID() : z.uuid().parse(task.graphThreadId),
        generation: z.int().positive().parse(task.graphGeneration) + (switchThread ? 1 : 0),
      } : undefined;
      const leaseUntil = new Date(Math.min(now.getTime() + this.config.leaseMs, deadline.getTime()));
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE ${table(message.taskType)} SET status = 'RUNNING', stage = 'SYNTHETIC_RUNNING', retry_at = NULL,
          fence_token = fence_token + 1, lease_owner = ${attemptId}::uuid, lease_until = ${leaseUntil},
          heartbeat_at = ${now}, updated_at = ${now}, budget_usage = ${JSON.stringify(budgetUsageSchema.parse({ ...usage, attempts: usage.attempts + 1 }))}::jsonb
          ${graph ? Prisma.sql`, active_graph_thread_id = ${graph.threadId}::uuid, graph_generation = ${graph.generation}` : Prisma.empty}
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
      return { kind: 'acquired', claim: { ownerId, consumerName: name, message, attemptId, fenceToken, startedAt: now, deadline, snapshot, ...(graph ? { graph } : {}) } };
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

  async markExecutionStopped(claim: ExecutionClaim): Promise<void> {
    await this.database.client.$transaction(async tx => {
      await tx.taskAttempt.updateMany({ where: { ownerId: claim.ownerId, taskId: claim.message.taskId,
        taskType: dbType(claim.message.taskType), attemptId: claim.attemptId, fenceToken: claim.fenceToken, executionStoppedAt: null },
      data: { executionStoppedAt: await databaseNow(tx) } });
    });
  }

  async cancelAtBoundary(claim: ExecutionClaim): Promise<boolean> {
    return this.database.client.$transaction(async tx => {
      const task = await lockTask(tx, claim.ownerId, claim.message);
      if (!task || task.status !== 'RUNNING' || !task.cancelRequested || task.fenceToken !== claim.fenceToken
        || task.generation !== claim.message.dispatchGeneration || task.leaseOwner !== claim.attemptId) return false;
      await finishCancellation(tx, claim.ownerId, claim.message.taskType, task, await databaseNow(tx));
      return true;
    });
  }

  private async requireAuthority(tx: Prisma.TransactionClient, claim: ExecutionClaim) {
    const row = await lockTask(tx, claim.ownerId, claim.message), now = await databaseNow(tx);
    if (!row || row.status !== 'RUNNING' || row.generation !== claim.message.dispatchGeneration || row.fenceToken !== claim.fenceToken
      || row.leaseOwner !== claim.attemptId || !row.leaseUntil || row.leaseUntil <= now || claim.deadline <= now || row.cancelRequested
      || (claim.graph && (row.graphThreadId !== claim.graph.threadId || row.graphGeneration !== claim.graph.generation))) throw new ExecutionLeaseLostError();
    return row;
  }

  async nodeArtifact(claim: ExecutionClaim, node: SyntheticNodeOutput['node'], output?: unknown): Promise<SyntheticNodeOutput | null> {
    const inputHash = requestHash(claim.snapshot), componentVersion = 's17-synthetic-v1';
    const operationKey = requestHash({ ownerId: claim.ownerId, taskType: claim.message.taskType, taskId: claim.message.taskId,
      node, inputHash, componentVersion, schemaVersion: 1 });
    return this.database.client.$transaction(async tx => {
      await this.requireAuthority(tx, claim);
      const existing = await tx.nodeArtifact.findUnique({ where: { operationKey, ownerId: claim.ownerId } });
      if (existing) {
        const parsed = syntheticNodeOutputSchema.parse(existing.validatedOutput);
        if (parsed.node !== node || parsed.inputHash !== inputHash) throw new Error('ARTIFACT_IDENTITY_MISMATCH');
        return parsed;
      }
      if (output === undefined) return null;
      const validatedOutput = syntheticNodeOutputSchema.parse(output);
      if (validatedOutput.node !== node || validatedOutput.inputHash !== inputHash) throw new Error('ARTIFACT_INPUT_MISMATCH');
      await tx.nodeArtifact.create({ data: { id: randomUUID(), operationKey, ownerId: claim.ownerId,
        taskType: dbType(claim.message.taskType), taskId: claim.message.taskId,
        analysisTaskId: claim.message.taskType === 'analysis' ? claim.message.taskId : null,
        jobIndexTaskId: claim.message.taskType === 'job-index' ? claim.message.taskId : null,
        node, inputHash, componentVersion, schemaVersion: 1, fenceToken: claim.fenceToken, validatedOutput } });
      return validatedOutput;
    });
  }

  async publishSyntheticIndex(claim: ExecutionClaim, target: string): Promise<void> {
    if (claim.message.taskType !== 'job-index') throw new Error('INDEX_TASK_REQUIRED');
    const snapshot = jobIndexInputSnapshotSchema.parse(claim.snapshot), id = z.uuid().parse(target);
    await this.database.client.$transaction(async tx => {
      await this.requireAuthority(tx, claim);
      const result = await tx.syntheticIndexTarget.updateMany({ where: { id, ownerId: claim.ownerId,
        jobVersionId: snapshot.jobVersionId, embeddingVersion: snapshot.embeddingVersion, indexVersion: snapshot.indexVersion },
      data: { status: 'READY', completedByTaskId: claim.message.taskId } });
      if (result.count !== 1) throw new ExecutionLeaseLostError();
    });
  }

  async reserveUsage(claim: ExecutionClaim, input: unknown): Promise<void> {
    const delta = usageReservationSchema.parse(input);
    await this.database.client.$transaction(async tx => {
      const task = await lockTask(tx, claim.ownerId, claim.message), now = await databaseNow(tx);
      if (!task || task.status !== 'RUNNING' || task.fenceToken !== claim.fenceToken || task.leaseOwner !== claim.attemptId
        || task.generation !== claim.message.dispatchGeneration || !task.leaseUntil || task.leaseUntil <= now || task.cancelRequested) throw new ExecutionLeaseLostError();
      if (claim.deadline <= now) throw new TaskFailure('DEADLINE_EXCEEDED');
      const usage = budgetUsageSchema.parse(task.budgetUsage);
      if (delta.modelCalls > claim.snapshot.budget.maxModelCalls - usage.modelCalls
        || delta.tokens > claim.snapshot.budget.maxTokens - usage.tokens
        || delta.costMicros > claim.snapshot.budget.maxCostMicros - usage.costMicros) throw new TaskFailure('BUDGET_EXHAUSTED');
      const next = budgetUsageSchema.parse({ ...usage, modelCalls: usage.modelCalls + delta.modelCalls,
        tokens: usage.tokens + delta.tokens, costMicros: usage.costMicros + delta.costMicros });
      await tx.$executeRaw(Prisma.sql`UPDATE ${table(claim.message.taskType)} SET budget_usage = ${JSON.stringify(next)}::jsonb
        WHERE owner_id = ${claim.ownerId}::uuid AND id = ${claim.message.taskId}::uuid AND fence_token = ${claim.fenceToken}`);
      const updated = await tx.taskAttempt.updateMany({ where: { ownerId: claim.ownerId, attemptId: claim.attemptId,
        taskId: claim.message.taskId, taskType: dbType(claim.message.taskType), fenceToken: claim.fenceToken, endedAt: null },
      data: { tokens: { increment: delta.tokens }, costMicros: { increment: delta.costMicros } } });
      if (updated.count !== 1) throw new ExecutionLeaseLostError();
    });
  }

  async fail(claim: ExecutionClaim, failure: TaskFailure): Promise<void> {
    await this.database.client.$transaction(async tx => {
      const task = await lockTask(tx, claim.ownerId, claim.message), now = await databaseNow(tx);
      if (!task || task.status !== 'RUNNING' || task.fenceToken !== claim.fenceToken || task.leaseOwner !== claim.attemptId
        || task.generation !== claim.message.dispatchGeneration || task.cancelRequested || !task.leaseUntil) throw new ExecutionLeaseLostError();
      // At the frozen deadline the lease is deliberately capped. The current token may finalize
      // that timeout, but never renew/produce output after expiry or supersede a new claimant.
      if (task.leaseUntil <= now && !(claim.deadline <= now && task.leaseUntil >= claim.deadline)) throw new ExecutionLeaseLostError();
      const receipt = await tx.consumerReceipt.findFirst({ where: { ownerId: claim.ownerId, consumerName: claim.consumerName,
        messageId: claim.message.messageId, taskId: task.id, taskType: dbType(claim.message.taskType),
        generation: task.generation, status: 'RUNNING', leaseOwner: claim.attemptId } });
      if (!receipt) throw new ExecutionLeaseLostError();
      const usage = budgetUsageSchema.parse(task.budgetUsage);
      usage.elapsedMs += Math.max(0, now.getTime() - claim.startedAt.getTime());
      const first = await tx.taskAttempt.findFirstOrThrow({ where: { ownerId: claim.ownerId, taskType: dbType(claim.message.taskType), taskId: task.id }, orderBy: { startedAt: 'asc' } });
      const totalDeadline = first.startedAt.getTime() + claim.snapshot.budget.maxDurationMs;
      let code = failure.code;
      if (now.getTime() >= totalDeadline) code = 'DEADLINE_EXCEEDED';
      else if (isRetryable(code) && usage.attempts >= claim.snapshot.budget.maxAttempts) code = 'BUDGET_EXHAUSTED';
      const due = new Date(now.getTime() + executionRetryDelay(usage.attempts));
      let retryAt: Date | null = null;
      if (isRetryable(code)) {
        if (due.getTime() >= totalDeadline) code = 'DEADLINE_EXCEEDED';
        else retryAt = due;
      }
      await finishFailure(tx, claim.ownerId, claim.message, task, now, code, retryAt, usage, claim.attemptId);
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
