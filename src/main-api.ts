import { loadConfig } from './modules/config/app-config.js';
import { reportStartupFailure } from './startup-error.js';

try {
  const config = loadConfig('api', process.env);
  const { startApi } = await import('./bootstrap-api.js');
  await startApi(config);
} catch (error) {
  reportStartupFailure(error);
}
