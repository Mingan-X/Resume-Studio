import { loadCheckpointConfig, loadCheckpointSetupUrl } from './config.js';
import { provisionCheckpoint, setupCheckpoint } from './admin.js';
import { ConfigValidationError } from '../../modules/config/app-config.js';

try {
  const config = loadCheckpointConfig(process.env);
  const setupUrl = loadCheckpointSetupUrl(process.env);
  if (process.argv[2] === 'provision' && process.argv.length === 3) await provisionCheckpoint(config, setupUrl);
  else if (process.argv[2] === 'setup' && process.argv.length === 3) await setupCheckpoint(config, setupUrl);
  else throw new Error('Expected provision or setup.');
  process.stdout.write('Checkpoint administration completed.\n');
} catch (error) {
  process.stderr.write(JSON.stringify({
    code: error instanceof ConfigValidationError ? 'CONFIG_INVALID' : 'CHECKPOINT_ADMIN_FAILED',
    ...(error instanceof ConfigValidationError ? { fields: error.fields } : {}),
  }) + '\n');
  process.exitCode = 1;
}
