import { loadConfig } from './modules/config/app-config.js';
import { reportStartupFailure } from './startup-error.js';

try {
  const config = loadConfig('worker', process.env);
  const { startWorker } = await import('./bootstrap-worker.js');
  await startWorker(config);
} catch (error) {
  reportStartupFailure(error);
}
