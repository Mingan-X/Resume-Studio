import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { ownedRabbit } from '../messaging/ownership.js';
import { declareTaskTopology, taskTopology } from '../messaging/task-topology.js';
import { grantTaskPermissions, installTaskPolicy, verifyTaskTopology } from '../messaging/task-topology.admin.js';
import { withRabbitConnection } from '../messaging/confirmed-publisher.js';
import { OutboxModule } from './outbox.module.js';
import { OutboxPublisher } from './outbox.publisher.js';
import { DatabaseService } from '../database/database.service.js';
import { configuredServiceOwner } from '../consumer/service-identity.js';

async function main() {
  const config = loadInfrastructureConfig(process.env);
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['setup', 'publish'].includes(command ?? '')) throw new Error('Invalid command.');
  await ownedRabbit();
  if (command === 'setup') {
    const topology = taskTopology();
    await grantTaskPermissions();
    await installTaskPolicy(topology);
    await withRabbitConnection(config.rabbitmqUrl, 15_000, async connection => {
      const channel = await connection.createChannel();
      channel.on('error', () => {});
      await declareTaskTopology(channel, topology);
    });
    await verifyTaskTopology(topology);
    console.log(JSON.stringify({ event: 'task_topology_ready', namespace: topology.namespace }));
    return;
  }
  await ownedPostgres();
  const database=new DatabaseService(config);let owner:string;
  try{owner=await configuredServiceOwner(database,process.env);}finally{await database.onModuleDestroy();}
  const app = await NestFactory.createApplicationContext(OutboxModule.register(config,{getOwnerId:()=>Promise.resolve(owner)}), { logger: false, abortOnError: false });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const results = await app.get(OutboxPublisher).runBatch(abort.signal);
    console.log(JSON.stringify({ event: 'outbox_batch_completed', results }));
    if (results.some(result => !['published', 'idle'].includes(result))) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await app.close();
  }
}

try { await main(); }
catch {
  console.error(JSON.stringify({ event: 'outbox_command_failed', code: 'OUTBOX_COMMAND_FAILED' }));
  process.exitCode = 1;
}
