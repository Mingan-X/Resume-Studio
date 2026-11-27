import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';

const commands = {
  api: ['dist/src/main-api.js'], analysis: ['dist/src/infrastructure/tasks/analysis-worker.cli.js', 'consume'],
  index: ['dist/src/infrastructure/jobs/index-worker.cli.js', 'consume'], publisher: ['dist/src/infrastructure/outbox/cli.js', 'publish'],
  'analysis-reconciler': ['dist/src/infrastructure/tasks/analysis-worker.cli.js', 'reconcile-watch'],
  'index-reconciler': ['dist/src/infrastructure/jobs/index-worker.cli.js', 'reconcile-watch'],
  lifecycle: ['dist/src/infrastructure/tasks/lifecycle.cli.js', 'watch'],
};
const role = process.argv[2], command = Object.hasOwn(commands, role) ? commands[role] : undefined;
if (!command || process.argv.length !== 3) { console.error(JSON.stringify({ code: 'SUPERVISOR_ROLE_INVALID' })); process.exit(1); }
const abort = new globalThis.AbortController(); let child, timer, failures = 0;
const stop = () => { abort.abort(); child?.kill('SIGTERM'); timer = setTimeout(() => child?.kill('SIGKILL'), 15000); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  while (!abort.signal.aborted) {
    child = spawn(process.execPath, ['--env-file=/run/secrets/runtime.env', '--env-file=/run/secrets/checkpoint.env',
      '--env-file=/run/secrets/observability.env', ...command], { stdio: 'inherit', shell: false });
    const current = child;
    const result = await new Promise(resolve => {
      current.once('error', () => resolve(1)); current.once('exit', code => resolve(code ?? 1));
    });
    child = undefined;
    if (abort.signal.aborted) break;
    failures = result === 0 ? 0 : failures + 1;
    console.log(JSON.stringify({ code: 'SUPERVISOR_CHILD_EXIT', role, exitCode: result, consecutiveFailures: failures }));
    if (failures >= 3) { process.exitCode = 1; break; }
    // Process restart never resets the task's persisted retry/token/cost/deadline budgets.
    const wait = result === 0 ? 2000 : Math.min(30000, 2000 * 2 ** (failures - 1)) + Math.floor(Math.random() * 1000);
    await delay(wait, undefined, { signal: abort.signal }).catch(() => {});
  }
} finally {
  clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  // No stopped marker is written to task rows. Only the actual worker's durable protocol may do that.
}
