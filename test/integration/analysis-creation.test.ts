import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../../src/app-api.module.js';
import { configureHttp, createApi } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { TaskApiModule } from '../../src/modules/tasks/task-api.module.js';
import { IDENTITY } from '../../src/modules/identity/identity.module.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { AnalysisRepository } from '../../src/infrastructure/tasks/analysis.repository.js';
import { ResumeRepository } from '../../src/infrastructure/storage/resume.repository.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobCorpusRepository } from '../../src/infrastructure/jobs/corpus.repository.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { analysisInputSnapshotSchema, budgetUsageSchema, taskDispatchSchema } from '../../src/contracts/tasks.js';
import { createAnalysisResponseSchema } from '../../src/contracts/analyses.js';
import { taskResponseSchema } from '../../src/contracts/task-api.js';
import { rubricVersionSchema } from '../../src/contracts/rubric.js';
import { extractedDocument } from '../../src/modules/resumes/evidence.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { analysisConfiguration } from '../support/analysis-inputs.js';
import { jobDraft } from '../support/job-inputs.js';

await test('S2.4 real analysis HTTP freezes authorized resources, idempotency, rollback and synthetic rejection', { timeout: 90_000 }, async t => {
  await ownedPostgres();
  const config = loadInfrastructureConfig(process.env), owners = [randomUUID(), randomUUID()]; let ownerId = owners[0]!;
  const settings = analysisConfiguration();
  const module = await Test.createTestingModule({ imports: [ApiModule.register(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000' }),
    [TaskApiModule.register({ databaseUrl: config.databaseUrl }, settings)])] })
    .overrideProvider(IDENTITY).useValue({ getOwnerId: async () => ownerId }).compile();
  const app = module.createNestApplication({ logger: false }); configureHttp(app);
  const database = module.get(DatabaseService), db = database.client, repository = module.get(AnalysisRepository);
  mkdirSync('data/s24-analysis-runs', { recursive: true }); const manifestPath = `data/s24-analysis-runs/${ownerId}.json`;
  const save = (cleaned = false) => writeFileSync(manifestPath, JSON.stringify({ owners, cleaned })); save();
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const id of owners) await db.$transaction(async tx => {
        await tx.outboxEvent.deleteMany({ where: { ownerId: id } });
        await tx.analysisTask.deleteMany({ where: { ownerId: id } });
        await tx.analysisConfiguration.deleteMany({ where: { ownerId: id } });
        await tx.rubricVersion.deleteMany({ where: { ownerId: id } });
        await tx.jobCorpusVersion.deleteMany({ where: { ownerId: id } });
        await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } });
        await tx.jobIndexTask.deleteMany({ where: { ownerId: id } });
        await tx.jobVersion.deleteMany({ where: { ownerId: id } }); await tx.job.deleteMany({ where: { ownerId: id } });
        await tx.resumeUpload.deleteMany({ where: { ownerId: id } }); await tx.extractedDocument.deleteMany({ where: { ownerId: id } });
        await tx.evidenceBlock.deleteMany({ where: { ownerId: id } }); await tx.resumeVersion.deleteMany({ where: { ownerId: id } });
        await tx.resume.deleteMany({ where: { ownerId: id } }); await tx.fileAsset.deleteMany({ where: { ownerId: id } });
        await tx.owner.deleteMany({ where: { id } });
      }); save(true);
    } finally { await app.close(); }
  });
  for (const id of owners) await db.owner.create({ data: { id } });
  const versionId = randomUUID(), fileHash = 'a'.repeat(64);
  const document = extractedDocument(versionId, fileHash, { parserVersion: 'test-parser-v1', warnings: [],
    blocks: [{ text: '合成简历：TypeScript工程实践。', location: { kind: 'PDF', page: 1, bounds: null } }] });
  await new ResumeRepository(database).register({ ownerId, idempotencyKey: randomUUID(), resumeId: randomUUID(), resumeVersionId: versionId,
    file: { id: randomUUID(), ownerId, storageKey: randomUUID(), sha256: fileHash, mime: 'application/pdf', size: 10, createdAt: new Date().toISOString() },
    blocks: document.blocks, document });
  const jobs = new JobRepository(database), publication = new JobPublicationRepository(database), draft = jobDraft(ownerId);
  await jobs.createDraft(ownerId, draft); await publication.confirm(ownerId, draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
  await publication.publish(ownerId, draft.id, randomUUID(), { embeddingVersion: settings.embeddingVersion,
    indexVersion: settings.indexTarget.indexVersion, chunkerVersion: settings.indexTarget.chunkerVersion,
    componentVersion: settings.indexTarget.componentVersion, budget: settings.budget });
  await new JobCorpusRepository(database).freeze(ownerId, 'test-corpus-v1', [draft.id], skillDictionaryV1);
  await jobs.importRubric(ownerId, rubricVersionSchema.parse(JSON.parse(readFileSync('resources/rubrics/rubric-v1.json', 'utf8')) as unknown));
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const request = { resumeVersionId: versionId, asOfDate: '2026-11-27', jobCorpusVersionId: 'test-corpus-v1' }, key = randomUUID();
  const send = (body: unknown, idempotencyKey = key) => fetch(`${base}/api/v1/analyses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) });
  const [response, concurrent] = await Promise.all([send(request), send(request)]); assert.equal(response.status, 202);
  const result = createAnalysisResponseSchema.parse(await response.json());
  assert.equal(concurrent.status, 202); assert.deepEqual(await concurrent.json(), result);
  const task = await db.analysisTask.findUniqueOrThrow({ where: { id: result.taskId } });
  const snapshot = analysisInputSnapshotSchema.parse(task.inputSnapshot); assert.equal(snapshot.kind, 'analysis');
  assert.equal(task.realResumeVersionId, versionId); assert.equal(task.corpusVersion, request.jobCorpusVersionId);
  assert.equal(snapshot.modelConfigVersion, settings.modelConfigVersion);
  assert.equal(taskResponseSchema.parse(await (await fetch(base + result.statusUrl)).json()).status, 'QUEUED');
  await t.test('same request converges, config rotation preserves replay, changed input conflicts', async () => {
    const responses = await Promise.all([send(request), send(request)]);
    for (const item of responses) { assert.equal(item.status, 202); assert.deepEqual(await item.json(), result); }
    assert.equal(await repository.create(ownerId, key, request, null), result.taskId);
    const conflict = await send({ ...request, asOfDate: '2026-11-26' }); assert.equal(conflict.status, 409); await conflict.body?.cancel();
    assert.equal(await db.analysisTask.count({ where: { ownerId } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { ownerId, aggregateType: 'AnalysisTask' } }), 1);
  });
  await t.test('foreign/missing resources and client config are rejected without an Outbox', async () => {
    const invalid = await send({ ...request, budget: settings.budget }, randomUUID()); assert.equal(invalid.status, 400); await invalid.body?.cancel();
    const missing = await send({ ...request, resumeVersionId: randomUUID() }, randomUUID()); assert.equal(missing.status, 404); await missing.body?.cancel();
    ownerId = owners[1]!;
    const foreign = await send(request, randomUUID()); assert.equal(foreign.status, 404); await foreign.body?.cancel();
    const lookup = await fetch(base + result.statusUrl); assert.equal(lookup.status, 404); await lookup.body?.cancel();
    assert.equal(await db.analysisTask.count({ where: { ownerId } }), 0); ownerId = owners[0]!;
    await assert.rejects(repository.create(ownerId, randomUUID(), request, { ...settings, promptVersion: 'changed-same-version' }));
    await assert.rejects(db.analysisTask.update({ where: { id: task.id }, data: { corpusVersion: 'changed' } }));
    await assert.rejects(db.analysisConfiguration.update({ where: { ownerId_version: { ownerId, version: settings.configurationVersion } }, data: { contentHash: 'b'.repeat(64) } }));
    await assert.rejects(db.resumeVersion.delete({ where: { id: versionId } }));
    await assert.rejects(db.analysisTask.create({ data: { ...task, budgetUsage: budgetUsageSchema.parse(task.budgetUsage), id: randomUUID(), idempotencyKey: randomUUID(),
      inputSnapshot: { ...snapshot, corpusHash: 'b'.repeat(64) } } }));
    await assert.rejects(db.analysisTask.create({ data: { ...task, inputSnapshot: snapshot, budgetUsage: budgetUsageSchema.parse(task.budgetUsage),
      id: randomUUID(), idempotencyKey: randomUUID(), realResumeVersionId: null } }));
  });
  await t.test('failure after task insertion rolls back task/configuration/Outbox together', async () => {
    const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
      get(current, name, receiver) {
        if (name === 'outboxEvent') return { create: () => { throw new Error('TEST_OUTBOX_FAILURE'); } };
        const value: unknown = Reflect.get(current, name, receiver); return typeof value === 'function' ? value.bind(current) : value;
      },
    }) satisfies Prisma.TransactionClient)) } };
    const failedKey = randomUUID();
    await assert.rejects(new AnalysisRepository(broken).create(ownerId, failedKey, request, { ...settings, configurationVersion: 'rollback-v1' }), /TEST_OUTBOX_FAILURE/);
    assert.equal(await db.analysisTask.count({ where: { ownerId, idempotencyKey: failedKey } }), 0);
    assert.equal(await db.analysisConfiguration.count({ where: { ownerId, version: 'rollback-v1' } }), 0);
    assert.equal(await db.outboxEvent.count({ where: { ownerId, aggregateType: 'AnalysisTask' } }), 1);
  });
  await t.test('synthetic entry defers real work without spending attempts or committing success', async () => {
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: task.id, ownerId } });
    const execution = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
    assert.deepEqual(await execution.claim(ownerId, taskDispatchSchema.parse(event.payload)), { kind: 'deferred' });
    assert.equal(await db.taskAttempt.count({ where: { ownerId, taskId: task.id } }), 0);
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'QUEUED');
  });
  await t.test('actual API assembly exposes a safe 503 when the analysis configuration is absent', async () => {
    const actual = await createApi(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000', TASK_API_ENABLED: 'true', DATABASE_URL: config.databaseUrl }));
    try {
      await actual.listen(0, '127.0.0.1');
      const result = await fetch(`${await actual.getUrl()}/api/v1/analyses`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(request) });
      assert.equal(result.status, 503);
      assert.match(JSON.stringify(await result.json()), /ANALYSIS_UNAVAILABLE/);
    } finally { await actual.close(); }
  });
});
