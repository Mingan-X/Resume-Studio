import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { taskTypeSchema } from '../../contracts/tasks.js';
import type { TaskType } from '../../contracts/tasks.js';
import { ExecutionUnsettledError } from './contracts.js';

// One stable key for the consumer session lock and the reconciler's transaction lock.
// A hash collision only delays unrelated work; it cannot grant concurrent execution.
export function executionLockKey(ownerId: string, taskType: TaskType, taskId: string): string {
  const identity = [z.uuid().parse(ownerId).toLowerCase(), taskTypeSchema.parse(taskType), z.uuid().parse(taskId).toLowerCase()];
  return createHash('sha256').update(`resume-studio:task-execution:v1:${identity.join(':')}`).digest().readBigInt64BE().toString();
}

export interface ExecutionLock {
  run<T>(ownerId: string, type: TaskType, taskId: string, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T | null>;
}

export class PostgresExecutionLock implements ExecutionLock {
  constructor(private readonly pool: Pool) {}

  async run<T>(ownerId: string, type: TaskType, taskId: string, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const key = executionLockKey(ownerId, type, taskId);
    signal.throwIfAborted();
    const client = await this.pool.connect();
    const lost = new AbortController();
    const disconnected = () => lost.abort();
    client.on('error', disconnected); client.on('end', disconnected);
    let acquired = false, discard = false;
    const combined = AbortSignal.any([signal, lost.signal]);
    try {
      combined.throwIfAborted();
      const response = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
      acquired = z.array(z.object({ acquired: z.boolean() })).length(1).parse(response.rows)[0]!.acquired;
      if (!acquired) return null;
      const result = await work(combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      // A failed acquisition may have reached PostgreSQL. Discarding the connection releases any uncertain lock.
      if (!acquired || lost.signal.aborted || error instanceof ExecutionUnsettledError) discard = true;
      throw error;
    } finally {
      try {
        if (acquired && !lost.signal.aborted && !discard) {
          const response = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key]);
          if (!z.array(z.object({ unlocked: z.boolean() })).length(1).parse(response.rows)[0]!.unlocked) discard = true;
        }
      } catch { discard = true; }
      client.removeListener('error', disconnected); client.removeListener('end', disconnected);
      client.release(discard || lost.signal.aborted);
    }
  }
}
