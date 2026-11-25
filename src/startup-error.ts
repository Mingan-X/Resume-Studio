import { ConfigValidationError } from './modules/config/app-config.js';

// This module must remain usable before any application/Nest module is loaded.
export function reportStartupFailure(error: unknown, code = 'STARTUP_FAILED'): void {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: 'error',
    code: error instanceof ConfigValidationError ? 'CONFIG_INVALID' : code,
    ...(error instanceof ConfigValidationError ? { fields: error.fields } : {}),
  })}\n`);
  process.exitCode = 1;
}
