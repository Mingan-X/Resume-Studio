import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../../src/app-api.module.js';
import { createApi, configureHttp } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { JobApiModule } from '../../src/modules/jobs/job-api.module.js';
import { IDENTITY } from '../../src/modules/identity/identity.module.js';
import { JOB_INDEX_TARGET } from '../../src/modules/jobs/job-publication.service.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { jobVersionResponseSchema, jobListResponseSchema } from '../../src/contracts/job-api.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';
import { jobDraft } from '../support/job-inputs.js';
import { JobExtractionService } from '../../src/modules/jobs/job-extraction.service.js';
import { ModelExecutor } from '../../src/modules/models/model-executor.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';

await test('S2.2 HTTP drafts, confirmation, immutable publication, owner isolation, suggestions and safe field errors', { timeout: 90000 }, async t => {
  await ownedPostgres();
  const config = loadInfrastructureConfig(process.env), owners = [randomUUID(), randomUUID()]; let ownerId = owners[0]!;
  const target = jobIndexTargetSchema.parse({ embeddingVersion: 'http-fixture-v1', indexVersion: 'http-fixture-v1', chunkerVersion: 'jd-text-v1', componentVersion: 'http-fixture-v1',
    budget: { maxAttempts: 3, maxModelCalls: 1, maxTokens: 100, maxCostMicros: 100, currency: 'CNY', maxDurationMs: 30000 } });
  const module = await Test.createTestingModule({ imports: [ApiModule.register(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000' }), [await JobApiModule.register({ databaseUrl: config.databaseUrl })])] })
    .overrideProvider(IDENTITY).useValue({ getOwnerId: async () => ownerId }).overrideProvider(JOB_INDEX_TARGET).useValue(target).compile();
  const app = module.createNestApplication({ logger: false }); configureHttp(app);
  const database = module.get(DatabaseService), db = database.client;
  await db.owner.createMany({ data: owners.map(id => ({ id })) });
  t.after(async () => {
    try { await ownedPostgres(); for (const id of owners) await db.$transaction(async tx => {
      await tx.outboxEvent.deleteMany({ where: { ownerId: id } }); await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } });
      await tx.jobIndexTask.deleteMany({ where: { ownerId: id } }); await tx.jobVersion.deleteMany({ where: { ownerId: id } });
      await tx.job.deleteMany({ where: { ownerId: id } }); await tx.owner.delete({ where: { id } });
    }); } finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const send = (path: string, body: unknown, method = 'POST', key?: string) => fetch(`${base}/api/v1/jobs${path}`, {
    method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body),
  });
  const body = '合成岗位：工程实践与自动化测试。';
  const created = await send('', { title: '合成工程师', city: null, level: null, skills: ['TypeScript'], body });
  assert.equal(created.status, 201); const initial = jobVersionResponseSchema.parse(await created.json());
  const path = `/${initial.jobId}/versions/${initial.id}`;
  await t.test('source validation, missing model and field errors do not mutate draft', async () => {
    const invalid = await send('', { title: '', city: null, level: null, skills: [], body, ownerId }); assert.equal(invalid.status, 400);
    const error = JSON.stringify(await invalid.json()); assert.ok(error.includes('details')); assert.ok(error.includes('title')); assert.ok(!error.includes(ownerId));
    const missing = await send(`${path}/suggestions`, {}); assert.equal(missing.status, 503); assert.equal(z.object({ code: z.string() }).parse(await missing.json()).code, 'MODEL_UNAVAILABLE');
    const template = jobDraft(ownerId).requirements[0]!;
    const requirement = { ...template, sourceRef: { ...template.sourceRef, sourceVersionId: initial.id, blockId: initial.document.blocks[0]!.id } };
    const forged = await send(path, { kind: 'requirement-upsert', requirement: { ...requirement, sourceRef: { ...requirement.sourceRef, quote: '编造的要求' } } }, 'PATCH');
    assert.equal(forged.status, 400); await forged.body?.cancel();
    const edited = await send(path, { kind: 'requirement-upsert', requirement }, 'PATCH'); assert.equal(edited.status, 200); await edited.body?.cancel();
  });
  await t.test('confirmation gates publish; idempotent transaction returns one task and keeps real index pending', async () => {
    const key = randomUUID(); const denied = await send(`${path}/publish`, {}, 'POST', key); assert.equal(denied.status, 409); await denied.body?.cancel();
    const confirm = await send(`${path}/confirm`, { hardRequirementsConfirmed: true, weightsConfirmed: true }); assert.equal(confirm.status, 200); await confirm.body?.cancel();
    const published = await send(`${path}/publish`, {}, 'POST', key); assert.equal(published.status, 202); const result: unknown = await published.json();
    const replay = await send(`${path}/publish`, {}, 'POST', key); assert.equal(replay.status, 202); assert.deepEqual(await replay.json(), result);
    assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 1); assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 1);
    const stored = jobVersionResponseSchema.parse(await (await fetch(`${base}/api/v1/jobs${path}`)).json());
    assert.equal(stored.status, 'PUBLISHED'); assert.equal(stored.indexStatus, 'PENDING'); assert.ok(!JSON.stringify(stored).includes('ownerId'));
    const next = await send(path, { kind: 'metadata', metadata: { title: '修订草稿', city: null, level: null, skills: [] } }, 'PATCH');
    assert.equal(next.status, 200); const draft = jobVersionResponseSchema.parse(await next.json()); assert.equal(draft.version, 2); assert.equal(draft.status, 'DRAFT');
    const conflict = await send(`/${draft.jobId}/versions/${draft.id}/publish`, {}, 'POST', key); assert.equal(conflict.status, 409); await conflict.body?.cancel();
  });
  await t.test('list/latest/version enforce ownership and cursor ordering', async () => {
    const second = await send('', { title: '第二岗位', city: null, level: null, skills: [], body }); assert.equal(second.status, 201); await second.body?.cancel();
    const list = jobListResponseSchema.parse(await (await fetch(`${base}/api/v1/jobs?limit=1`)).json()); assert.ok(list.nextCursor);
    const next = jobListResponseSchema.parse(await (await fetch(`${base}/api/v1/jobs?limit=1&cursor=${list.nextCursor}`)).json());
    assert.notEqual(next.items[0]?.id, list.items[0]?.id); assert.equal(next.nextCursor, null);
    ownerId = owners[1]!;
    for (const suffix of [`/${initial.jobId}`, path]) { const result = await fetch(`${base}/api/v1/jobs${suffix}`); assert.equal(result.status, 404); await result.body?.cancel(); }
    for (const suffix of ['/publish', '/confirm', '/suggestions']) { const result = await send(path + suffix, suffix === '/confirm' ? { hardRequirementsConfirmed: true, weightsConfirmed: true } : {}, 'POST', randomUUID()); assert.equal(result.status, 404); await result.body?.cancel(); }
    assert.equal(jobListResponseSchema.parse(await (await fetch(`${base}/api/v1/jobs`)).json()).items.length, 0);
    ownerId = owners[0]!;
  });
  await t.test('test-only model suggestions validate evidence and leave the real database draft unchanged', async () => {
    const latest = await module.get(JobRepository).latestVersion(ownerId, initial.jobId); assert.ok(latest);
    const before = JSON.stringify(latest);
    const executor = new ModelExecutor({ modelConfigVersion: 'http-test-model', invoke: async () => ({ output: { requirements: latest.requirements }, usage: null }) },
      { singleTimeoutMs: 500, totalTimeoutMs: 2000, maxAttempts: 2, maxRetries: 0, maxTokens: 200000, maxCostMicros: 2000, currency: 'CNY', inputTokenReservation: 90000, maxOutputTokens: 100, costReservationMicros: 1000, retryBaseMs: 5, retryCapMs: 10, maxConcurrent: 1 });
    const service = new JobExtractionService({ getOwnerId: async () => ownerId }, module.get(JobRepository), executor);
    const wired = module.get(JobExtractionService), original = wired.suggest.bind(wired);
    wired.suggest = service.suggest.bind(service);
    try {
      const result = await send(`/${latest.jobId}/versions/${latest.id}/suggestions`, {}); assert.equal(result.status, 200);
      const body = z.object({ suggestions: z.object({ requirements: z.array(z.unknown()) }), inputHash: z.string() }).parse(await result.json());
      assert.equal(body.suggestions.requirements.length, latest.requirements.length);
    } finally { wired.suggest = original; }
    assert.equal(JSON.stringify(await module.get(JobRepository).findVersion(ownerId, latest.id)), before);
  });
  await t.test('actual API assembly exposes disabled/configured route boundary', async () => {
    const actual = await createApi(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000', JOB_API_ENABLED: 'true', DATABASE_URL: config.databaseUrl }));
    try { await actual.listen(0, '127.0.0.1'); const result = await fetch(`${await actual.getUrl()}/api/v1/jobs/${randomUUID()}`); assert.equal(result.status, 404); await result.body?.cancel(); }
    finally { await actual.close(); }
  });
});
