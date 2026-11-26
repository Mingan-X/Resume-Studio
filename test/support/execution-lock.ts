import type { ExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';

// Pure handler tests only. Real integration suites always use PostgresExecutionLock.
export const unlockedUnitContext: ExecutionLock = {
  run: (_ownerId, _type, _taskId, signal, work) => work(signal),
};
