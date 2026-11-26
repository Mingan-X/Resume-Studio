import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { ownedRabbit } from '../messaging/ownership.js';
import { ReconciliationModule } from './reconciliation.module.js';
import { ReconciliationService } from './reconciliation.service.js';

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['once','watch'].includes(mode ?? '')) throw new Error('Expected once or watch.');
  const config = loadInfrastructureConfig(process.env);
  await ownedPostgres(); await ownedRabbit();
  const app = await NestFactory.createApplicationContext(ReconciliationModule.register(config), { logger: false, abortOnError: false });
  const abort = new AbortController(), stop = () => abort.abort();
  const onMessage = (value: unknown) => { if (value === 'shutdown') stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.on('message', onMessage);
  const report = (summary: Awaited<ReturnType<ReconciliationService['runOnce']>>) => {
    console.log(JSON.stringify({ event: 'reconciliation_cycle', ...summary }));
  };
  try {
    const service = app.get(ReconciliationService);
    process.send?.({ type: 'ready', role: 'reconciler' });
    if (mode === 'watch') await service.watch(abort.signal, report);
    else {
      const summary = await service.runOnce(abort.signal); report(summary);
      if (summary.stopped || summary.tasks.some(value => ['error','delivery-failed','lock-held'].includes(value))
        || summary.publications.some(value => !['published','idle'].includes(value)) || (summary.outbox?.failed ?? 0) > 0) process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('message', onMessage);
    await app.close(); if (process.connected) process.disconnect();
  }
}
try { await main(); }
catch { console.error(JSON.stringify({ event: 'reconciliation_failed', code: 'RECONCILIATION_FAILED' })); process.exitCode = 1; }
