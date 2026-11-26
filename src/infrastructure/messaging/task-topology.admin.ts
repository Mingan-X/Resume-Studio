import { z } from 'zod';
import { rabbitAdmin } from './ownership.js';
import { taskPolicy } from './task-topology.js';
import type { TaskTopology } from './task-topology.js';

const policySchema = z.object({
  name: z.string(), pattern: z.string(), 'apply-to': z.string(), priority: z.number(),
  definition: z.union([z.string().transform(value => JSON.parse(value) as unknown), z.record(z.string(), z.unknown())])
    .pipe(z.record(z.string(), z.unknown())),
});

export async function installTaskPolicy(topology: TaskTopology): Promise<void> {
  const pattern = `^${topology.namespace.replaceAll('.', '\\.')}\\.(analysis|job-index)\\.v1$`;
  const policies = z.array(policySchema).parse(await rabbitAdmin(['list_policies', '-p', 'resume-studio-s12-test', '--formatter', 'json']));
  const existing = policies.find(policy => policy.name === topology.policy);
  // Never overwrite a policy of unknown provenance or silently change existing behavior.
  if (existing && (existing.pattern !== pattern || existing['apply-to'] !== 'quorum_queues'
    || existing.priority !== 10 || JSON.stringify(Object.entries(existing.definition).sort()) !== JSON.stringify(Object.entries(taskPolicy(topology)).sort()))) {
    throw new Error('Existing task policy differs; review it before changing it.');
  }
  if (!existing) await rabbitAdmin(['set_policy', '-p', 'resume-studio-s12-test', topology.policy, pattern,
    JSON.stringify(taskPolicy(topology)), '--priority', '10', '--apply-to', 'quorum_queues']);
}

export async function grantTaskPermissions(): Promise<void> {
  const permissions = z.array(z.object({ user: z.string(), configure: z.string(), write: z.string(), read: z.string() }))
    .parse(await rabbitAdmin(['list_permissions', '-p', 'resume-studio-s12-test', '--formatter', 'json']));
  const existing = permissions.find(permission => permission.user === 'resume_studio_test');
  const restricted = '^(s12\\.|resume\\.(tasks|dead|analysis\\.v1|job-index\\.v1|analysis\\.dead\\.v1|job-index\\.dead\\.v1)$)';
  if (!existing || [existing.configure, existing.write, existing.read].some(value => value !== '^s12\\.' && value !== restricted)) {
    throw new Error('Unexpected existing RabbitMQ permissions; refusing to overwrite them.');
  }
  await rabbitAdmin(['set_permissions', '-p', 'resume-studio-s12-test', 'resume_studio_test', restricted, restricted, restricted]);
}

export async function verifyTaskTopology(topology: TaskTopology): Promise<void> {
  const queues = z.array(z.object({ name: z.string(), type: z.string(), durable: z.boolean(), policy: z.string() }))
    .parse(await rabbitAdmin(['list_queues', '-p', 'resume-studio-s12-test', 'name', 'type', 'durable', 'policy', '--formatter', 'json']));
  for (const name of [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead]) {
    const queue = queues.find(item => item.name === name);
    const main = name === topology.analysis || name === topology.jobIndex;
    if (!queue?.durable || queue.type !== 'quorum' || queue.policy !== (main ? topology.policy : '')) {
      throw new Error('Task queue declaration or effective policy does not match.');
    }
  }
}
