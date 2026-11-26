import { execFileSync } from 'node:child_process';
import { z } from 'zod';

// Resolve only containers owned by this project's Compose, never user-supplied names.
const compose = ['compose', '--env-file', 'infra/.env', '-f', 'infra/compose.yaml'];
const ownedContainer = service => {
  const id = execFileSync('docker', [...compose, 'ps', '-q', service], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Project container is not running.');
  const info = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', id], { encoding: 'utf8' }));
  if (info['com.docker.compose.project'] !== 'resume-studio' || info['com.docker.compose.service'] !== service) {
    throw new Error('Refusing a container outside the Resume Studio project.');
  }
  return id;
};
if (process.argv.length > 2) throw new Error('Container name arguments are no longer accepted.');
const input = z.object({
  postgresContainer: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/),
  rabbitContainer: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/),
  postgresPassword: z.string().regex(/^[a-f0-9]{48}$/),
  rabbitPassword: z.string().regex(/^[a-f0-9]{48}$/),
}).safeParse({
  postgresContainer: ownedContainer('postgres'), rabbitContainer: ownedContainer('rabbitmq'),
  postgresPassword: process.env.POSTGRES_PASSWORD, rabbitPassword: process.env.RABBITMQ_PASSWORD,
});
if (!input.success) throw new Error('Expected project containers and generated infra/.env credentials.');
const c = input.data;
const docker = (args, stdin) => execFileSync('docker', args, {
  input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
});
try {
  // Psql reads SQL via stdin; the generated password is never a host command argument.
  const sql = String.raw`
SELECT 'CREATE ROLE resume_studio_test LOGIN PASSWORD ''${c.postgresPassword}'''
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resume_studio_test')\gexec
SELECT 'CREATE DATABASE resume_studio_s12_test OWNER resume_studio_test'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'resume_studio_s12_test')\gexec
SELECT CASE WHEN pg_get_userbyid(datdba) = 'resume_studio_test' THEN 1 ELSE 0 END AS correct_owner
FROM pg_database WHERE datname = 'resume_studio_s12_test';
`;
  const result = docker(['exec', '-i', c.postgresContainer, 'sh', '-c',
    'exec psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d postgres'], sql);
  if (result.trim().split('\n').at(-1) !== '1') throw new Error('Unexpected database ownership.');
  const shell = `set -eu
read -r provision_password
if ! rabbitmqctl -q list_users | cut -f1 | grep -Fxq resume_studio_test; then
  rabbitmqctl -q add_user resume_studio_test "$provision_password" >/dev/null
fi
if ! rabbitmqctl -q list_vhosts name | grep -Fxq resume-studio-s12-test; then
  rabbitmqctl -q add_vhost resume-studio-s12-test >/dev/null
fi
rabbitmqctl -q set_user_tags resume_studio_test >/dev/null
`;
  docker(['exec', '-i', c.rabbitContainer, 'sh', '-c', shell], c.rabbitPassword + '\n');
  // Preserve the exact T3 grant when re-provisioning; never broaden other vhosts/users.
  const current = z.array(z.object({ user: z.string(), configure: z.string(), read: z.string(), write: z.string() }))
    .parse(JSON.parse(docker(['exec', c.rabbitContainer, 'rabbitmqctl', '-q', 'list_permissions',
      '-p', 'resume-studio-s12-test', '--formatter', 'json']))).find(item => item.user === 'resume_studio_test');
  const taskGrant = '^(s12\\.|resume\\.(tasks|dead|analysis\\.v1|job-index\\.v1|analysis\\.dead\\.v1|job-index\\.dead\\.v1)$)';
  const grant = current && [current.configure, current.read, current.write].every(value => value === taskGrant)
    ? taskGrant : '^s12\\.';
  docker(['exec', c.rabbitContainer, 'rabbitmqctl', '-q', 'set_permissions', '-p', 'resume-studio-s12-test',
    'resume_studio_test', grant, grant, grant]);
  console.log('Isolated test database/role and RabbitMQ vhost/user are ready; existing passwords were not rotated.');
} catch {
  // Do not dump child_process exceptions: they may contain SQL or passwords.
  console.error('Infrastructure provisioning failed. Check container availability and ownership; credentials were not logged.');
  process.exitCode = 1;
}
