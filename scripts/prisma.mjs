import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const allowed = new Set(['generate', 'deploy', 'status', 'validate']);
const command = process.argv[2];
if (!allowed.has(command)) throw new Error('Expected generate, deploy, status or validate.');
const args = command === 'deploy' || command === 'status' ? ['migrate', command] : [command];
// Caller uses Node --env-file; do not pass credentials on the command line.
const child = spawn(process.execPath, [require.resolve('prisma/build/index.js'), ...args], { stdio: 'inherit' });
child.once('error', () => { console.error('Prisma could not start.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
