import type { ChildProcess } from 'node:child_process';
import type { ExecutionClaim } from './contracts.js';
import type { TaskExecutionStore } from './task-execution.store.js';

// Local supervisor boundary. Caller binds this child to its claim through private IPC.
// Sending kill or losing an advisory lock is NOT evidence of exit.
export async function confirmWorkerExit(child: ChildProcess, claim: ExecutionClaim,
  tasks: Pick<TaskExecutionStore, 'markExecutionStopped'>): Promise<void> {
  if (!child.pid || (child.exitCode === null && child.signalCode === null)) throw new Error('WORKER_EXIT_NOT_CONFIRMED');
  await tasks.markExecutionStopped(claim);
}
