import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { WorkerModule } from './app-worker.module.js';
import type { WorkerConfig } from './modules/config/app-config.js';
import { AppLogger } from './infrastructure/logging/app-logger.js';
import { registerShutdown } from './lifecycle.js';

export async function createWorker(config: WorkerConfig): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(WorkerModule.register(config), {
    logger: false, abortOnError: false,
  });
}

export async function startWorker(config: WorkerConfig): Promise<void> {
  const app = await createWorker(config);
  registerShutdown(app);
  app.get(AppLogger).write('info', { event: 'application_started' });
  process.send?.({ type: 'ready', role: 'worker' });
}
