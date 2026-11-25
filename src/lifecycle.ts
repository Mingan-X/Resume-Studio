import type { INestApplicationContext } from '@nestjs/common';
import { AppLogger } from './infrastructure/logging/app-logger.js';
import { reportStartupFailure } from './startup-error.js';

export function registerShutdown(app: INestApplicationContext): void {
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 5_000);
    void app.close().then(() => {
      app.get(AppLogger).write('info', { event: 'application_stopped' });
      clearTimeout(timeout);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('message', onMessage);
      if (process.connected) process.disconnect();
    }).catch(() => {
      reportStartupFailure(new Error('Shutdown failed'), 'SHUTDOWN_FAILED');
      process.exit(1);
    });
  };
  const onMessage = (message: unknown): void => {
    // A private parent/child IPC channel lets Windows tests exercise the same stop path.
    if (message === 'shutdown') stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.send) process.on('message', onMessage);
}
