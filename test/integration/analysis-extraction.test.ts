import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { AnalysisRepository } from '../../src/infrastructure/tasks/analysis.repository.js';
import { ResumeRepository } from '../../src/infrastructure/storage/resume.repository.js';
import { ResumeExtractionRepository } from '../../src/infrastructure/tasks/resume-extraction.repository.js';
import { ResumeExtractionService } from '../../src/modules/analysis/extraction.service.js';
import { AnalysisModelCaller } from '../../src/modules/analysis/model-caller.js';
import { ModelExecutor } from '../../src/modules/models/model-executor.js';
import { parsedResumeSchema } from '../../src/contracts/parsed-resume.js';
import { budgetUsageSchema, taskDispatchSchema } from '../../src/contracts/tasks.js';
import { seedRealAnalysis, cleanRealAnalysis } from '../support/real-analysis.js';

await test('S2.4 extraction cache is shared by resume/prompt/model, fenced and immutable with durable usage', { timeout: 90_000 }, async t => {
  await ownedPostgres(); const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const ownerId = randomUUID(); mkdirSync('data/s24-extraction-runs', { recursive: true }); const manifest = `data/s24-extraction-runs/${ownerId}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ ownerId, cleaned })); save();
  t.after(async () => { try { await ownedPostgres(); await cleanRealAnalysis(database, ownerId); save(true); } finally { await database.onModuleDestroy(); } });
  const seeded = await seedRealAnalysis(database, ownerId), store = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
  const acquire = async (message: unknown) => {
    const result = await store.claim(ownerId, message, 'analysis', seeded.snapshot.embeddingVersion, seeded.snapshot.modelConfigVersion);
    if (result.kind !== 'acquired') assert.fail(); return result.claim;
  };
  const first = await acquire(seeded.message), block = seeded.document.blocks[0]!; let calls = 0;
  const output = parsedResumeSchema.parse({ schemaVersion: 1, resumeVersionId: seeded.document.sourceVersionId, education: [], work: [], projects: [],
    skills: [{ name: 'TypeScript', context: null, sourceRefs: [{ sourceType: 'RESUME', sourceVersionId: seeded.document.sourceVersionId,
      blockId: block.id, start: 0, end: block.text.length, quote: block.text }] }] });
  const caller = new AnalysisModelCaller(new ModelExecutor({ modelConfigVersion: seeded.snapshot.modelConfigVersion,
    invoke: async () => { calls++; return { output, usage: null }; } },
  { singleTimeoutMs: 1000, totalTimeoutMs: 5000, maxAttempts: 2, maxRetries: 0, maxTokens: 200000, maxCostMicros: 1000,
    currency: 'CNY', inputTokenReservation: 90000, maxOutputTokens: 1000, costReservationMicros: 10, retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 1 }));
  const repository = new ResumeExtractionRepository(database, database.pool), service = new ResumeExtractionService(new ResumeRepository(database), repository, caller);
  const interrupted = new ResumeExtractionService(new ResumeRepository(database), {
    load: repository.load.bind(repository), exclusive: repository.exclusive.bind(repository),
    save: async () => { throw new Error('INJECTED_AFTER_MODEL_RETURN'); },
  }, caller);
  await assert.rejects(interrupted.extract(first, { reserve: delta => store.reserveUsage(first, delta) }, new AbortController().signal), /INJECTED_AFTER_MODEL_RETURN/);
  assert.equal(calls, 1); assert.equal(await db.resumeExtraction.count({ where: { ownerId } }), 0);
  assert.equal(budgetUsageSchema.parse((await db.analysisTask.findUniqueOrThrow({ where: { id: first.message.taskId } })).budgetUsage).modelCalls, 1);
  const result = await service.extract(first, { reserve: delta => store.reserveUsage(first, delta) }, new AbortController().signal);
  assert.equal(calls, 2); // Lost output can repeat a model call; durable reservations are not reset.
  const nextId = await new AnalysisRepository(database).create(ownerId, randomUUID(), { resumeVersionId: seeded.snapshot.resumeVersionId,
    asOfDate: '2026-12-01', jobCorpusVersionId: seeded.snapshot.jobCorpusVersionId }, seeded.settings);
  const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: nextId } }), next = await acquire(taskDispatchSchema.parse(event.payload));
  assert.deepEqual(await service.extract(next, { reserve: delta => store.reserveUsage(next, delta) }, new AbortController().signal), result);
  assert.equal(calls, 2); assert.equal(await db.resumeExtraction.count({ where: { ownerId } }), 1);
  const firstUsage = budgetUsageSchema.parse((await db.analysisTask.findUniqueOrThrow({ where: { id: first.message.taskId } })).budgetUsage);
  const nextUsage = budgetUsageSchema.parse((await db.analysisTask.findUniqueOrThrow({ where: { id: nextId } })).budgetUsage);
  assert.equal(firstUsage.modelCalls, 2); assert.equal(nextUsage.modelCalls, 0);
  await assert.rejects(db.resumeExtraction.update({ where: { id: result.id }, data: { content: {} } }));
  await assert.rejects(service.extract({ ...next, fenceToken: next.fenceToken + 1n }, { reserve: async () => {} }, new AbortController().signal), /LEASE_LOST/);
  assert.equal(calls, 2);
  await assert.rejects(repository.exclusive(next, new AbortController().signal, async () => {
    await repository.exclusive(next, new AbortController().signal, async () => true);
  }), /DEPENDENCY_UNAVAILABLE/);
});
