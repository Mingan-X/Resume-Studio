import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform, arch, cpus, totalmem } from 'node:os';
import { createApi } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { authSessionResponseSchema, authMeResponseSchema } from '../../src/contracts/auth.js';
import { createAnalysisResponseSchema } from '../../src/contracts/analyses.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { readSessionCookie, tokenHash } from '../../src/modules/auth/session-token.js';
import { seedRealAnalysis, cleanRealAnalysis } from '../support/real-analysis.js';
import { verifyProjectNetwork } from '../support/project-network.js';

const runId = randomUUID(), ownerId = randomUUID(), directory = resolve('data/s33-performance', runId);
const infrastructure = loadInfrastructureConfig(process.env), database = new DatabaseService(infrastructure), db = database.client;
let app: Awaited<ReturnType<typeof createApi>> | undefined, cleaned = false;
const sessions: string[] = [];
await mkdir(directory, { recursive: true });
const save = () => writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ runId, ownerId, cleaned }, null, 2)); await save();
try {
  await verifyProjectNetwork(await ownedPostgres());
  const seeded = await seedRealAnalysis(database, ownerId), origin = 'https://resume.example';
  const configuration = resolve(directory, 'configuration.json'); await writeFile(configuration, JSON.stringify(seeded.settings), { flag: 'wx' });
  const username = `performance-${runId}`, password = `synthetic-performance-${runId}`;
  await db.account.create({ data: { id: randomUUID(), ownerId, username, passwordHash: await hashPassword(password) } });
  app = await createApi(loadConfig('api', { APP_ENV: 'production', HTTP_PORT: '3000', TASK_API_ENABLED: 'true',
    AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, DATABASE_URL: infrastructure.databaseUrl, ANALYSIS_CONFIG_FILE: configuration }));
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const initial = await fetch(`${base}/api/v1/auth/session`), session = authSessionResponseSchema.parse(await initial.json());
  sessions.push(tokenHash(readSessionCookie(initial.headers.get('set-cookie')!)!));
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin,
    cookie: initial.headers.get('set-cookie')!, 'x-csrf-token': session.csrfToken }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200); const active = authMeResponseSchema.parse(await login.json());
  sessions.push(tokenHash(readSessionCookie(login.headers.get('set-cookie')!)!));
  const headers = { 'content-type': 'application/json', origin, cookie: login.headers.get('set-cookie')!, 'x-csrf-token': active.csrfToken };
  const body = JSON.stringify({ resumeVersionId: seeded.snapshot.resumeVersionId, asOfDate: '2026-11-28', jobCorpusVersionId: seeded.snapshot.jobCorpusVersionId });
  const samples: { phase: 'warmup' | 'measured'; elapsedMs: number; status: number; valid: boolean }[] = [];
  for (let index = 0; index < 55; index++) {
    const start = performance.now();
    const response = await fetch(`${base}/api/v1/analyses`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
      body, signal: AbortSignal.timeout(10_000) });
    const valid = createAnalysisResponseSchema.safeParse(await response.json()).success;
    samples.push({ phase: index < 5 ? 'warmup' : 'measured', elapsedMs: performance.now() - start, status: response.status, valid });
  }
  const measured = samples.filter(item => item.phase === 'measured'), sorted = measured.map(item => item.elapsedMs).sort((a, b) => a - b);
  const report = { schemaVersion: 1, runId, performedAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, memoryBytes: totalmem(),
      database: 'local Docker PostgreSQL, existing project volume on mechanical disk', transport: 'loopback HTTP with real session/CSRF',
      concurrency: 1, modelCalls: 0, jobCount: 1, resumeCount: 1 },
    samples: measured.length, warmup: 5, failed: measured.filter(item => item.status !== 202 || !item.valid).length,
    latencyMs: { min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted.at(-1), mean: sorted.reduce((sum, item) => sum + item, 0) / sorted.length },
    observations: samples, analysisDurationMs: null, modelTokens: null, modelCostMicros: null,
    limitation: 'One process, sequential requests, synthetic stored inputs; excludes startup/login/TLS/model/queue execution. No production latency guarantee.' };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ code: 'TASK_CREATION_MEASURED', runId, samples: report.samples, failed: report.failed, latencyMs: report.latencyMs }));
  assert.ok(samples.every(item => item.status === 202 && item.valid));
  assert.equal(await db.analysisTask.count({ where: { ownerId } }), 56);
  assert.equal(await db.outboxEvent.count({ where: { ownerId, aggregateType: 'AnalysisTask' } }), 56);
} catch { console.error(JSON.stringify({ code: 'TASK_PERFORMANCE_FAILED', runId })); process.exitCode = 1; }
finally {
  try {
    await app?.close(); await verifyProjectNetwork(await ownedPostgres());
    assert.equal(await db.taskAttempt.count({ where: { ownerId } }), 0, 'Unexpected worker activity: retain data for verified cleanup');
    await db.authSession.deleteMany({ where: { OR: [{ account: { ownerId } }, { tokenHash: { in: sessions } }] } });
    await db.account.deleteMany({ where: { ownerId } }); await cleanRealAnalysis(database, ownerId);
    assert.equal(await db.owner.count({ where: { id: ownerId } }), 0); cleaned = true; await save();
  } finally { await database.onModuleDestroy(); }
}
