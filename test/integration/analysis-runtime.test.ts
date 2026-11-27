import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { createCheckpointStore } from '../../src/infrastructure/checkpoint/store.js';
import { loadCheckpointConfig } from '../../src/infrastructure/checkpoint/config.js';
import { JobIndexVector } from '../../src/infrastructure/vector/job-index.vector.js';
import { createJobIndexDelivery } from '../../src/infrastructure/jobs/index-runtime.js';
import { createAnalysisRuntime } from '../../src/infrastructure/tasks/analysis-runtime.js';
import { AnalysisRepository } from '../../src/infrastructure/tasks/analysis.repository.js';
import { ModelExecutor } from '../../src/modules/models/model-executor.js';
import { EmbeddingExecutor } from '../../src/modules/embeddings/embedding-executor.js';
import { taskDispatchSchema, budgetUsageSchema } from '../../src/contracts/tasks.js';
import { parsedResumeSchema } from '../../src/contracts/parsed-resume.js';
import { profileModelOutputSchema } from '../../src/contracts/profile.js';
import { matchModelOutputSchema } from '../../src/contracts/matching.js';
import { analysisSummarySchema } from '../../src/contracts/analysis-summary.js';
import { dimensionIds } from '../../src/contracts/jobs.js';
import { indexCollectionSchema } from '../../src/contracts/job-index.js';
import { rubricVersionSchema } from '../../src/contracts/rubric.js';
import { AnalysisSummaryRepository } from '../../src/infrastructure/tasks/analysis-summary.repository.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import type { IndexCollection } from '../../src/contracts/job-index.js';
import { indexCollectionName } from '../../src/modules/recall/job-chunks.js';
import { analysisConfiguration } from '../support/analysis-inputs.js';
import { SyntheticEmbedding } from '../support/synthetic-embedding.js';
import { seedRealAnalysis, cleanRealAnalysis } from '../support/real-analysis.js';
import { qdrantTestTarget } from '../support/native-qdrant.js';
import { cleanIndexCollections } from '../support/index-cleanup.js';

await test('S2.4 real analysis graph commits success/partial/failure, freezes candidates and preserves unique 400 budget', { timeout: 240_000 }, async t => {
  await ownedPostgres(); const config = loadInfrastructureConfig(process.env), target = await qdrantTestTarget(config); await target.verify();
  const database = new DatabaseService(config), db = database.client, checkpoints = createCheckpointStore(loadCheckpointConfig(process.env));
  const owners: string[] = [], specs: IndexCollection[] = [], confirmed = new Set<string>(), threads = new Set<string>();
  const vector = new JobIndexVector({ url: target.config.qdrantUrl, apiKey: target.config.qdrantApiKey }, target.verify);
  mkdirSync('data/s24-runtime-runs', { recursive: true }); const manifest = `data/s24-runtime-runs/${randomUUID()}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ owners, specs, confirmed: [...confirmed], threads: [...threads], target: target.cleanupTarget, cleaned })); save();
  t.after(async () => {
    try {
      await cleanIndexCollections(specs, confirmed, vector, target.verify);
      await ownedPostgres();
      for (const ownerId of owners) for (const task of await db.analysisTask.findMany({ where: { ownerId } })) threads.add(task.activeGraphThreadId);
      save(); for (const thread of threads) await checkpoints.saver.deleteThread(thread);
      for (const ownerId of owners) await cleanRealAnalysis(database, ownerId); save(true);
    } finally { await checkpoints.close(); await database.onModuleDestroy(); }
  });
  const embedding = new EmbeddingExecutor(new SyntheticEmbedding(), { singleTimeoutMs: 1000, totalTimeoutMs: 5000, maxAttempts: 1,
    retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 1, inputTokenReservation: 20000, costReservationMicros: 10, maxTokens: 20000, maxCostMicros: 10, currency: 'CNY' });
  const settings = () => {
    const result = analysisConfiguration(); result.embeddingVersion = embedding.embeddingVersion;
    result.indexTarget = { ...result.indexTarget, embeddingVersion: embedding.embeddingVersion, provenance: 'synthetic', dimensions: embedding.dimensions };
    result.budget.maxModelCalls = 100; result.budget.maxTokens = 10_000_000; result.budget.maxCostMicros = 10000;
    return result;
  };
  for (const large of [false, true]) await t.test(large ? '420 requirements allocate 400 once and retain 20 explicit budget rows' : 'unknown is valid success; failures/degradation/cancellation never become fabricated success', async () => {
    const ownerId = randomUUID(); owners.push(ownerId); save();
    const seeded = await seedRealAnalysis(database, ownerId, { settings: settings(), jobCount: large ? 2 : 1, requirementCount: large ? 210 : 3, allowSynthetic: true });
    threads.add(seeded.taskId); const spec = indexCollectionSchema.parse({ ...seeded.settings.indexTarget, ownerId }); specs.push(spec); save();
    await vector.ensure(spec, { signal: AbortSignal.timeout(15000), deadline: Date.now() + 15000 }); confirmed.add(indexCollectionName(spec)); save();
    const identity = { getOwnerId: async () => ownerId }, index = createJobIndexDelivery(database, identity, embedding, vector, { allowSynthetic: true });
    for (const draft of seeded.drafts) {
      const task = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, jobVersionId: draft.id } });
      const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: task.id } });
      assert.equal(await index.delivery.handle(taskDispatchSchema.parse(event.payload), new AbortController().signal), 'ack');
    }
    let mode: 'ok' | 'profile-failed' | 'all-failed' = 'ok', calls = 0, extractCalls = 0, activeMatches = 0, peakMatches = 0;
    const block = seeded.document.blocks[0]!, ref = { sourceType: 'RESUME', sourceVersionId: seeded.document.sourceVersionId, blockId: block.id, start: 0, end: block.text.length, quote: block.text };
    const parsed = parsedResumeSchema.parse({ schemaVersion: 1, resumeVersionId: seeded.document.sourceVersionId, education: [], work: [], projects: [], skills: [{ name: 'TypeScript', context: null, sourceRefs: [ref] }] });
    const model = new ModelExecutor({ modelConfigVersion: seeded.snapshot.modelConfigVersion, invoke: async request => {
      calls++;
      if (request.schema === parsedResumeSchema) { extractCalls++; return { output: parsed, usage: null }; }
      if (request.schema === profileModelOutputSchema) {
        const data = z.object({ rubric: rubricVersionSchema }).parse(JSON.parse(String(request.messages[1]!.content)) as unknown);
        const first = data.rubric.dimensions[0]!, level = first.levels.find(item => item.level === 2)!;
        return { output: mode !== 'ok' ? { totalScore: 100 } : { judgments: dimensionIds.map(dimension => dimension === first.dimension ? {
          dimension, status: 'assessed', level: 2, featureIds: [level.features[0]!.featureId], evidenceRefs: [ref],
          rubricRefs: [{ rubricVersion: data.rubric.version, dimension, level: 2, featureId: level.features[0]!.featureId }], reason: '合成等级判断',
        } : { dimension, status: 'unknown', level: null, featureIds: [], evidenceRefs: [], rubricRefs: [], reason: '合成样本证据不足' }) }, usage: null };
      }
      assert.equal(request.schema, matchModelOutputSchema); activeMatches++; peakMatches = Math.max(peakMatches, activeMatches);
      try {
        const data = z.object({ requirements: z.array(z.object({ requirementId: z.string() })) }).parse(JSON.parse(String(request.messages[1]!.content)) as unknown);
        return { output: mode === 'all-failed' ? { judgments: [] } : { judgments: data.requirements.map(item => ({ requirementId: item.requirementId,
          verdict: 'met', evidenceRefs: [ref], reason: '测试合成判断，不代表模型质量' })) }, usage: null };
      } finally { activeMatches--; }
    } }, { singleTimeoutMs: 2000, totalTimeoutMs: 10000, maxAttempts: 2, maxRetries: 0, maxTokens: 300000, maxCostMicros: 1000,
      currency: 'CNY', inputTokenReservation: 100000, maxOutputTokens: 4000, costReservationMicros: 10, retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 4 });
    const runtime = createAnalysisRuntime(database, identity, loadCheckpointConfig(process.env), model, embedding, vector, { allowSynthetic: true });
    assert.equal(await runtime.delivery.handle(seeded.message, new AbortController().signal), 'ack');
    const firstTask = await db.analysisTask.findUniqueOrThrow({ where: { id: seeded.taskId } });
    assert.equal(firstTask.status, large ? 'PARTIAL' : 'SUCCEEDED'); assert.equal(firstTask.reportId, null);
    const summary = analysisSummarySchema.parse((await db.analysisSummary.findFirstOrThrow({ where: { taskId: seeded.taskId } })).content);
    assert.equal(summary.planned, large ? 420 : 3); assert.equal(summary.completed, large ? 400 : 3); assert.equal(summary.truncated, large ? 20 : 0);
    assert.equal(summary.failed, 0); assert.equal(summary.pending, 0); assert.ok(peakMatches <= 3);
    const before = calls; assert.equal(await runtime.delivery.handle(seeded.message, new AbortController().signal), 'ack'); assert.equal(calls, before);
    assert.equal(await db.consumerReceipt.count({ where: { ownerId, taskId: seeded.taskId, status: 'DONE' } }), 1);
    assert.equal(await db.nodeArtifact.count({ where: { ownerId, taskId: seeded.taskId } }), 10);
    assert.equal((await db.taskEvent.findMany({ where: { ownerId, taskId: seeded.taskId }, orderBy: { seq: 'desc' } }))[0]?.stage, firstTask.status);
    assert.ok(budgetUsageSchema.parse(firstTask.budgetUsage).modelCalls >= 3);
    const profile = await db.profileAssessment.findFirstOrThrow({ where: { taskId: seeded.taskId } });
    const profileContent = z.object({ scores: z.array(z.object({ score: z.number().nullable() })) }).parse(profile.content);
    assert.equal(profileContent.scores.filter(item => item.score === null).length, 5);
    assert.equal(profileContent.scores.find(item => item.score !== null)?.score, 40);
    if (large) return;
    const newTask = async (configuration = seeded.settings) => {
      const taskId = await new AnalysisRepository(database).create(ownerId, randomUUID(), { resumeVersionId: seeded.snapshot.resumeVersionId, asOfDate: seeded.snapshot.asOfDate,
        jobCorpusVersionId: seeded.snapshot.jobCorpusVersionId }, configuration, true);
      threads.add(taskId); save();
      return taskDispatchSchema.parse((await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: taskId } })).payload);
    };
    mode = 'profile-failed'; const partial = await newTask(); assert.equal(await runtime.delivery.handle(partial, new AbortController().signal), 'ack');
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: partial.taskId } })).status, 'PARTIAL');
    mode = 'all-failed'; const failed = await newTask(); assert.equal(await runtime.delivery.handle(failed, new AbortController().signal), 'ack');
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: failed.taskId } })).status, 'FAILED');
    assert.equal(extractCalls, 1); // Same resume/version reuses validated extraction for all tasks.
    mode = 'ok'; const cancelled = await newTask(); await db.analysisTask.update({ where: { id: cancelled.taskId }, data: { cancelRequested: true } });
    const beforeCancel = calls; assert.equal(await runtime.delivery.handle(cancelled, new AbortController().signal), 'ack'); assert.equal(calls, beforeCancel);
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: cancelled.taskId } })).status, 'CANCELLED');
    const config2 = { ...seeded.settings, configurationVersion: 'degraded-v1', indexTarget: { ...seeded.settings.indexTarget, indexVersion: 'not-ready-v2' },
      recall: { ...seeded.settings.recall, vectorFailure: 'keyword' as const } };
    const degraded = await newTask(config2); assert.equal(await runtime.delivery.handle(degraded, new AbortController().signal), 'ack');
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: degraded.taskId } })).status, 'PARTIAL');
    assert.equal(analysisSummarySchema.parse((await db.analysisSummary.findFirstOrThrow({ where: { taskId: degraded.taskId } })).content).degraded, true);
    const midCancel = await newTask(), validate = runtime.nodes.VALIDATE;
    runtime.nodes.VALIDATE = async (state, context) => {
      const value = await validate(state, context); await db.analysisTask.update({ where: { id: context.claim.message.taskId }, data: { cancelRequested: true } }); return value;
    };
    try { assert.equal(await runtime.delivery.handle(midCancel, new AbortController().signal), 'ack'); }
    finally { runtime.nodes.VALIDATE = validate; }
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: midCancel.taskId } })).status, 'CANCELLED');
    const crash = await newTask(), originalComplete = runtime.store.completeAnalysis.bind(runtime.store);
    const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
      get(current, name, receiver) {
        if (name === 'consumerReceipt') return new Proxy(current.consumerReceipt, { get(model, method, receiver) {
          if (method === 'updateMany') return () => { throw new Error('TEST_RECEIPT_FAILURE'); }; return Reflect.get(model, method, receiver);
        } });
        return Reflect.get(current, name, receiver);
      },
    }))) } };
    runtime.store.completeAnalysis = (claim, output) => new AnalysisSummaryRepository(broken).complete(claim, output);
    try { await assert.rejects(runtime.delivery.handle(crash, new AbortController().signal), /TEST_RECEIPT_FAILURE/); }
    finally { runtime.store.completeAnalysis = originalComplete; }
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: crash.taskId } })).status, 'RUNNING');
    assert.equal(await db.consumerReceipt.count({ where: { taskId: crash.taskId, status: 'DONE' } }), 0);
    const beforeRecovery = calls, originalSet = await db.candidateSet.findFirstOrThrow({ where: { taskId: crash.taskId } });
    await db.$executeRaw`UPDATE analysis_task SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${crash.taskId}::uuid`;
    assert.equal(await runtime.store.reconcile(ownerId, 'analysis', crash.taskId, reconciliationConfigSchema.parse({}), 'analysis', embedding.embeddingVersion, model.modelConfigVersion), 'recovered');
    const generation = (await db.analysisTask.findUniqueOrThrow({ where: { id: crash.taskId } })).generation;
    const replay = taskDispatchSchema.parse((await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: crash.taskId, payload: { path: ['dispatchGeneration'], equals: generation } } })).payload);
    assert.equal(await runtime.delivery.handle(replay, new AbortController().signal), 'ack'); assert.equal(calls, beforeRecovery);
    assert.equal((await db.analysisTask.findUniqueOrThrow({ where: { id: crash.taskId } })).status, 'SUCCEEDED');
    assert.deepEqual(await db.candidateSet.findFirstOrThrow({ where: { taskId: crash.taskId } }), originalSet);
  });
});
