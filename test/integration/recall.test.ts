import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobCorpusRepository } from '../../src/infrastructure/jobs/corpus.repository.js';
import { KeywordRecallRepository } from '../../src/infrastructure/jobs/keyword-recall.repository.js';
import { JobIndexRepository } from '../../src/infrastructure/jobs/index.repository.js';
import { createJobIndexDelivery } from '../../src/infrastructure/jobs/index-runtime.js';
import { JobIndexVector } from '../../src/infrastructure/vector/job-index.vector.js';
import { QDRANT_REQUEST_TIMEOUT_MS } from '../../src/infrastructure/vector/request-budget.js';
import { EmbeddingExecutor } from '../../src/modules/embeddings/embedding-executor.js';
import { SyntheticEmbedding } from '../support/synthetic-embedding.js';
import { RecallService } from '../../src/modules/recall/recall.service.js';
import { generateSyntheticJobs } from '../../src/modules/recall/synthetic-corpus.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { jdDocument } from '../../src/modules/jobs/evidence.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';
import { indexCollectionSchema, indexPointPayloadSchema } from '../../src/contracts/job-index.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { indexCollectionName } from '../../src/modules/recall/job-chunks.js';
import { TaskFailure } from '../../src/infrastructure/consumer/failure.js';
import { qdrantTestTarget } from '../support/native-qdrant.js';
import { cleanIndexCollections } from '../support/index-cleanup.js';
import { networkFaultProxy } from '../support/network-fault-proxy.js';

await test('S2.3 hybrid recall uses real Qdrant/SQL, aggregates chunks and explicitly degrades on index failures', { timeout: 180_000 }, async t => {
  await ownedPostgres();
  const config = loadInfrastructureConfig(process.env), qdrant = await qdrantTestTarget(config); await qdrant.verify();
  const database = new DatabaseService(config), db = database.client, ownerId = randomUUID(), other = randomUUID();
  const embedding = new EmbeddingExecutor(new SyntheticEmbedding(), { singleTimeoutMs: 1000, totalTimeoutMs: 10_000,
    maxAttempts: 2, retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 1, inputTokenReservation: 50_000,
    costReservationMicros: 10, maxTokens: 100_000, maxCostMicros: 20, currency: 'CNY' });
  const target = jobIndexTargetSchema.parse({ embeddingVersion: embedding.embeddingVersion, indexVersion: 'fixture-recall-v1',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1', budget: { maxAttempts: 3, maxModelCalls: 20,
      maxTokens: 1_000_000, maxCostMicros: 200, currency: 'CNY', maxDurationMs: 120_000 } });
  const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId,
    embeddingVersion: embedding.embeddingVersion, indexVersion: target.indexVersion, dimensions: 8, provenance: 'synthetic',
    chunkerVersion: target.chunkerVersion, componentVersion: target.componentVersion });
  const vector = new JobIndexVector({ url: qdrant.config.qdrantUrl, apiKey: qdrant.config.qdrantApiKey }, qdrant.verify);
  const client = new QdrantClient({ url: qdrant.config.qdrantUrl, apiKey: qdrant.config.qdrantApiKey, timeout: QDRANT_REQUEST_TIMEOUT_MS });
  const name = indexCollectionName(spec), confirmed = new Set<string>();
  mkdirSync('data/s23-recall-runs', { recursive: true }); const path = `data/s23-recall-runs/${ownerId}.json`;
  const save = (cleaned = false) => writeFileSync(path, JSON.stringify({ owners: [ownerId, other], spec, target: qdrant.cleanupTarget, confirmed: [...confirmed], cleaned })); save();
  t.after(async () => {
    try {
      await cleanIndexCollections([spec], confirmed, vector, qdrant.verify); await ownedPostgres();
      for (const id of [ownerId, other]) await db.$transaction(async tx => {
        await tx.nodeArtifact.deleteMany({ where: { ownerId: id } }); await tx.consumerReceipt.deleteMany({ where: { ownerId: id } });
        await tx.taskEvent.deleteMany({ where: { ownerId: id } }); await tx.taskAttempt.deleteMany({ where: { ownerId: id } });
        await tx.outboxEvent.deleteMany({ where: { ownerId: id } }); await tx.jobCorpusVersion.deleteMany({ where: { ownerId: id } });
        await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } }); await tx.jobIndexTask.deleteMany({ where: { ownerId: id } });
        await tx.jobVersion.deleteMany({ where: { ownerId: id } }); await tx.job.deleteMany({ where: { ownerId: id } });
        await tx.owner.deleteMany({ where: { id } });
      });
      save(true); t.diagnostic(`Exact-run recall collection/jobs/tasks/owners removed; Qdrant=${qdrant.kind}`);
    } finally { await database.onModuleDestroy(); }
  });
  await vector.ensure(spec, { deadline: Date.now() + 15_000, signal: AbortSignal.timeout(15_000) }); confirmed.add(name); save();
  for (const id of [ownerId, other]) await db.owner.create({ data: { id } });
  const identity = { getOwnerId: () => Promise.resolve(ownerId) }, jobs = new JobRepository(database), publication = new JobPublicationRepository(database);
  const runtime = createJobIndexDelivery(database, identity, embedding, vector, { allowSynthetic: true });
  const drafts = generateSyntheticJobs(ownerId).filter((_item, index) => [0, 1, 20, 30].includes(index));
  for (const [index, draft] of drafts.entries()) {
    const document = jdDocument(draft.id, draft.document.blocks[0]!.text + (index === 0 ? '\n合成项目开发与测试。'.repeat(200) : ''));
    await jobs.createDraft(ownerId, { ...draft, document, requirements: draft.requirements.map(requirement => ({ ...requirement,
      sourceRef: { ...requirement.sourceRef, blockId: document.blocks[0]!.id } })) });
    await publication.confirm(ownerId, draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
    const published = await publication.publish(ownerId, draft.id, randomUUID(), target);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: published.taskId } });
    assert.equal(await runtime.delivery.handle(taskDispatchSchema.parse(event.payload), AbortSignal.timeout(30_000)), 'ack');
  }
  await new JobCorpusRepository(database).freeze(ownerId, 'recall-v1', drafts.slice(0, 3).map(draft => draft.id), skillDictionaryV1);
  const keyword = new KeywordRecallRepository(database), indexes = new JobIndexRepository(database);
  const recall = new RecallService(identity, keyword, indexes, embedding, vector);
  const query = { schemaVersion: 1, corpusVersion: 'recall-v1', skills: ['TS', 'NodeJS'], summary: '合成项目开发与测试' };
  const settings = { version: 'hybrid-rrf-v1', vectorFailure: 'error' };
  const first = await recall.recall(query, settings, spec);
  assert.equal(first.degraded, false); assert.equal(first.candidates.length, 3);
  assert.equal(new Set(first.candidates.map(item => item.jobVersionId)).size, 3);
  assert.ok(first.candidates.every(item => item.jobVersionId !== drafts[3]!.id));
  assert.ok(first.candidates.every(item => item.sources.some(source => source.source === 'vector')));
  assert.deepEqual(await recall.recall(query, settings, spec), first);
  assert.equal((await recall.recall({ ...query, city: '上海' }, settings, spec)).candidates.length, 1);
  assert.equal((await recall.recall(query, { ...settings, limit: 1 }, spec)).candidates.length, 1);
  await assert.rejects(new RecallService({ getOwnerId: () => Promise.resolve(other) }, keyword, indexes, embedding, vector)
    .recall(query, settings, { ...spec, ownerId: other }), /CORPUS_NOT_FOUND/);
  // Another version/owner payload injected into this exact test collection cannot pass the query filters.
  const injected = randomUUID(), queryVector = (await embedding.run([query.summary])).vectors[0]!;
  await client.upsert(name, { wait: true, points: [{ id: injected, vector: queryVector,
    payload: indexPointPayloadSchema.parse({ schemaVersion: 1, kind: 'job-chunk', ownerId: other, visibility: 'private',
      jobVersionId: drafts[0]!.id, chunkId: randomUUID(), embeddingVersion: target.embeddingVersion,
      indexVersion: target.indexVersion, contentHash: 'a'.repeat(64), requirementsHash: 'b'.repeat(64), chunkHash: 'c'.repeat(64) }) }] });
  assert.deepEqual(await recall.recall(query, settings, spec), first);
  // Explicit vector failure policy, no fabricated vector ranks or implicit degradation.
  const unavailable = new RecallService(identity, keyword, indexes, embedding, { query: () => Promise.reject(new TaskFailure('UPSTREAM_TIMEOUT')) });
  await assert.rejects(unavailable.recall(query, settings, spec), /VECTOR_UNAVAILABLE/);
  const degraded = await unavailable.recall(query, { ...settings, vectorFailure: 'keyword' }, spec);
  assert.equal(degraded.degradationReason, 'VECTOR_UNAVAILABLE');
  assert.ok(degraded.candidates.every(item => item.sources.every(source => source.source === 'keyword')));
  // S3.3: interrupt real Qdrant transport for this caller, then recover the same collection.
  const proxy = await networkFaultProxy(qdrant.kind === 'native-windows' ? 6333 : 56333);
  try {
    const transport = new JobIndexVector({ url: `http://127.0.0.1:${proxy.port}`, apiKey: qdrant.config.qdrantApiKey }, qdrant.verify);
    const disrupted = new RecallService(identity, keyword, indexes, embedding, transport);
    assert.deepEqual(await disrupted.recall(query, settings, spec), first);
    proxy.block();
    await assert.rejects(disrupted.recall(query, settings, spec), /VECTOR_UNAVAILABLE/);
    const fallback = await disrupted.recall(query, { ...settings, vectorFailure: 'keyword' }, spec);
    assert.equal(fallback.degraded, true); assert.equal(fallback.degradationReason, 'VECTOR_UNAVAILABLE');
    assert.ok(fallback.candidates.every(item => item.sources.every(source => source.source === 'keyword')));
    proxy.unblock(); assert.deepEqual(await disrupted.recall(query, settings, spec), first);
  } finally { await proxy.close(); }
  await db.jobVersion.update({ where: { ownerId, id: drafts[0]!.id }, data: { indexStatus: 'PENDING' } });
  await assert.rejects(recall.recall(query, settings, spec), /INDEX_NOT_READY/);
  assert.equal((await recall.recall(query, { ...settings, vectorFailure: 'keyword' }, spec)).degradationReason, 'INDEX_NOT_READY');
  await db.jobVersion.update({ where: { ownerId, id: drafts[0]!.id }, data: { indexStatus: 'READY' } });
  // Server-side tie cutoff must explicitly fail rather than choose an arbitrary member.
  const ties = [randomUUID(), randomUUID()].map(id => ({ id, vector: queryVector, payload: indexPointPayloadSchema.parse({
    schemaVersion: 1, kind: 'job-chunk', ownerId, visibility: 'private', jobVersionId: drafts[0]!.id,
    chunkId: randomUUID(), embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion,
    contentHash: 'a'.repeat(64), requirementsHash: 'b'.repeat(64), chunkHash: 'c'.repeat(64) }) }));
  await client.upsert(name, { wait: true, points: ties });
  await assert.rejects(vector.query(spec, queryVector, [drafts[0]!.id], 1, { deadline: Date.now() + 15_000, signal: AbortSignal.timeout(15_000) }), /OUTPUT_INVALID/);
});
