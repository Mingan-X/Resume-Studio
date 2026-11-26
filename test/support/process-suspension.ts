import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const execute = promisify(execFile);

export async function suspendChild(child: ChildProcess, action: 'suspend' | 'resume'): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Expected a live owned fixture child.');
  if (process.platform !== 'win32') {
    if (!child.kill(action === 'suspend' ? 'SIGSTOP' : 'SIGCONT')) throw new Error('Child signal failed.');
    return;
  }
  await execute('powershell.exe', ['-NoProfile','-NonInteractive','-File',resolve('test/support/suspend-child.ps1'),
    '-ChildProcessId', String(child.pid), '-Action', action], { timeout: 10_000 });
}
