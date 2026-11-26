import type { Channel } from 'amqplib';
import { z } from 'zod';

// The optional namespace is reserved for exact-run integration resources.
export const topologyNamespaceSchema = z.union([
  z.literal('resume'), z.string().regex(/^s12\.t[345]\.[a-f0-9]{32}$/),
]);
export function taskTopology(namespace = 'resume') {
  const prefix = topologyNamespaceSchema.parse(namespace);
  return {
    namespace: prefix, exchange: `${prefix}.tasks`, deadExchange: `${prefix}.dead`,
    analysis: `${prefix}.analysis.v1`, jobIndex: `${prefix}.job-index.v1`,
    analysisDead: `${prefix}.analysis.dead.v1`, jobIndexDead: `${prefix}.job-index.dead.v1`,
    policy: `${prefix}.tasks.reliability.v1`,
  };
}
export type TaskTopology = ReturnType<typeof taskTopology>;

export function taskPolicy(topology: TaskTopology) {
  return {
    'dead-letter-exchange': topology.deadExchange,
    'dead-letter-strategy': 'at-least-once',
    overflow: 'reject-publish',
    'delivery-limit': 5,
    'consumer-timeout': 900_000,
  };
}

// Policy installation is an explicit admin operation, never a publisher-side request.
export async function declareTaskTopology(channel: Channel, topology: TaskTopology): Promise<void> {
  await channel.assertExchange(topology.exchange, 'direct', { durable: true });
  await channel.assertExchange(topology.deadExchange, 'direct', { durable: true });
  for (const name of [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead]) {
    await channel.assertQueue(name, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  }
  for (const [main, dead, route] of [
    [topology.analysis, topology.analysisDead, 'analysis.requested.v1'],
    [topology.jobIndex, topology.jobIndexDead, 'job.index.requested.v1'],
  ] as const) {
    await channel.bindQueue(main, topology.exchange, route);
    await channel.bindQueue(dead, topology.deadExchange, route);
    await channel.bindQueue(dead, topology.deadExchange, route.replace('.requested.', '.dead.'));
  }
}
