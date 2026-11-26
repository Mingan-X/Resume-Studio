import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { taskTypeSchema } from '../../contracts/tasks.js';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { ownedRabbit } from '../messaging/ownership.js';
import { ConsumerModule } from './consumer.module.js';
import { TaskConsumer } from './task.consumer.js';
import type { TaskExecutionStore } from './task-execution.store.js';

async function main() {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === 'checkpoint')) throw new Error('Expected task type and optional checkpoint mode.');
  const type = taskTypeSchema.parse(process.argv[2]);
  const config = loadInfrastructureConfig(process.env);
  await ownedPostgres(); await ownedRabbit();
  let createHandler;
  if (process.argv[3] === 'checkpoint') {
    if (type !== 'analysis') throw new Error('Checkpoint graph applies only to analysis.');
    const { loadCheckpointConfig } = await import('../checkpoint/config.js');
    const { CheckpointTaskHandler } = await import('../checkpoint/task-handler.js');
    const checkpoint = loadCheckpointConfig(process.env);
    createHandler = (tasks: TaskExecutionStore) => new CheckpointTaskHandler(checkpoint, tasks);
  }
  const app = await NestFactory.createApplicationContext(ConsumerModule.register(config, createHandler), { logger: false, abortOnError: false });
  const abort = new AbortController(), stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await app.get(TaskConsumer).run(type, {}, abort.signal);
    console.log(JSON.stringify({ event: 'task_consumer_session_completed', taskType: type, ...result }));
    if (!['limit', 'deadline'].includes(result.reason) || result.received !== result.acknowledged) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await app.close();
  }
}
try { await main(); }
catch { console.error(JSON.stringify({ event: 'task_consumer_failed', code: 'TASK_CONSUMER_FAILED' })); process.exitCode = 1; }
