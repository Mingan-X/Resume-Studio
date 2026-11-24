import 'reflect-metadata';
import { createWorker } from './bootstrap.js';
import { loadConfig } from './modules/config/app-config.js';
import { AppLogger } from './infrastructure/logging/app-logger.js';
import { registerShutdown, reportStartupFailure } from './lifecycle.js';

try {
  const app = await createWorker(loadConfig('worker', process.env));
  registerShutdown(app);
  app.get(AppLogger).write('info', { event: 'application_started' });
  process.send?.({ type: 'ready', role: 'worker' });
} catch (error) {
  reportStartupFailure(error);
}
