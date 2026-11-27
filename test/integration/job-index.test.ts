import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from 'amqplib';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { taskTopology, declareTaskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { installTaskPolicy } from '../../src/infrastructure/messaging/task-topology.admin.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox.publisher.js';
import { OutboxStore } from '../../src/infrastructure/outbox/outbox.store.js';
import { outboxConfigSchema } from '../../src/infrastructure/outbox/config.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobPublicationService } from '../../src/modules/jobs/job-publication.service.js';
import { JobCorpusRepository } from '../../src/infrastructure/jobs/corpus.repository.js';
import { JobIndexRepository } from '../../src/infrastructure/jobs/index.repository.js';
import { createJobIndexDelivery } from '../../src/infrastructure/jobs/index-runtime.js';
import { JobIndexVector } from '../../src/infrastructure/vector/job-index.vector.js';
import { QDRANT_REQUEST_TIMEOUT_MS } from '../../src/infrastructure/vector/request-budget.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';
import { taskDispatchSchema, jobIndexInputSnapshotSchema, budgetUsageSchema } from '../../src/contracts/tasks.js';
import { indexCollectionSchema } from '../../src/contracts/job-index.js';
import type { IndexCollection } from '../../src/contracts/job-index.js';
import { indexCollectionName } from '../../src/modules/recall/job-chunks.js';
import { EmbeddingExecutor } from '../../src/modules/embeddings/embedding-executor.js';
import { SyntheticEmbedding } from '../support/synthetic-embedding.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { generateSyntheticJobs } from '../../src/modules/recall/synthetic-corpus.js';
import { qdrantTestTarget } from '../support/native-qdrant.js';
import { cleanIndexCollections } from '../support/index-cleanup.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { TaskFailure } from '../../src/infrastructure/consumer/failure.js';

await test('S2.3 real index delivery upserts idempotently, commits READY atomically and fences old targets', { timeout: 180_000 }, async t => {
  await ownedPostgres(); await ownedRabbit();
  const baseline = loadInfrastructureConfig(process.env), qdrant = await qdrantTestTarget(baseline);
  await qdrant.verify();
  const database = new DatabaseService(baseline), db = database.client, ownerId = randomUUID();
  const identity = { getOwnerId: () => Promise.resolve(ownerId) }, specs: IndexCollection[] = [], confirmed = new Set<string>();
  const vector = new JobIndexVector({ url: qdrant.config.qdrantUrl, apiKey: qdrant.config.qdrantApiKey }, qdrant.verify);
  const client = new QdrantClient({ url: qdrant.config.qdrantUrl, apiKey: qdrant.config.qdrantApiKey, timeout: QDRANT_REQUEST_TIMEOUT_MS });
  const topology = taskTopology(`s12.t4.${randomUUID().replaceAll('-', '')}`);
  const connection = await connect(baseline.rabbitmqUrl, { timeout: 5000 }); connection.on('error', () => {});
  const channel = await connection.createChannel(); channel.on('error', () => {});
  mkdirSync('data/s23-index-runs', { recursive: true }); const path = `data/s23-index-runs/${ownerId}.json`;
  const save = (cleaned = false) => writeFileSync(path, JSON.stringify({ ownerId, namespace: topology.namespace, specs,
    confirmed: [...confirmed], target: qdrant.cleanupTarget, cleaned }, null, 2)); save();
  t.after(async () => {
    try {
      await cleanIndexCollections(specs, confirmed, vector, qdrant.verify);
      await ownedPostgres(); await ownedRabbit();
      for (const queue of [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead]) await channel.deleteQueue(queue);
      await channel.deleteExchange(topology.exchange); await channel.deleteExchange(topology.deadExchange);
      await rabbitAdmin(['clear_policy', '-p', 'resume-studio-s12-test', topology.policy]);
      await db.$transaction(async tx => {
        await tx.nodeArtifact.deleteMany({ where: { ownerId } }); await tx.consumerReceipt.deleteMany({ where: { ownerId } });
        await tx.taskEvent.deleteMany({ where: { ownerId } }); await tx.taskAttempt.deleteMany({ where: { ownerId } });
        await tx.outboxEvent.deleteMany({ where: { ownerId } }); await tx.jobCorpusVersion.deleteMany({ where: { ownerId } });
        await tx.jobIndexTarget.deleteMany({ where: { ownerId } }); await tx.jobIndexTask.deleteMany({ where: { ownerId } });
        await tx.jobVersion.deleteMany({ where: { ownerId } }); await tx.job.deleteMany({ where: { ownerId } });
        await tx.owner.deleteMany({ where: { id: ownerId } });
      });
      save(true); t.diagnostic(`Exact-run index metadata/collections/aliases/queues/DB cleaned; Qdrant=${qdrant.kind}`);
    } finally { await channel.close(); await connection.close(); await database.onModuleDestroy(); }
  });
  await installTaskPolicy(topology); await declareTaskTopology(channel, topology); await db.owner.create({ data: { id: ownerId } });
  const policy = { singleTimeoutMs: 1000, totalTimeoutMs: 10_000, maxAttempts: 2, retryBaseMs: 10, retryCapMs: 20,
    maxConcurrent: 1, inputTokenReservation: 50_000, costReservationMicros: 10, maxTokens: 100_000, maxCostMicros: 20, currency: 'CNY' };
  const embedding = new EmbeddingExecutor(new SyntheticEmbedding(), policy);
  const target = jobIndexTargetSchema.parse({ embeddingVersion: embedding.embeddingVersion, indexVersion: 'fixture-index-v1',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1', budget: { maxAttempts: 3, maxModelCalls: 10,
      maxTokens: 500_000, maxCostMicros: 100, currency: 'CNY', maxDurationMs: 120_000 } });
  const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId,
    embeddingVersion: target.embeddingVersion, indexVersion: target.indexVersion, dimensions: 8, provenance: 'synthetic',
    chunkerVersion: target.chunkerVersion, componentVersion: target.componentVersion });
  specs.push(spec); save();
  // Authorized 10s request ceiling remains bounded by the original 15s setup deadline.
  await vector.ensure(spec, { deadline: Date.now() + 15_000, signal: AbortSignal.timeout(15_000) });
  confirmed.add(indexCollectionName(spec)); save();
  assert.throws(() => createJobIndexDelivery(database, identity, embedding, vector), /OFFICIAL_EMBEDDING_REQUIRED/);
  const runtime = createJobIndexDelivery(database, identity, embedding, vector, { allowSynthetic: true });
  const jobs = new JobRepository(database), publications = new JobPublicationRepository(database);
  const publisherService = new JobPublicationService(identity, publications, target), draft = generateSyntheticJobs(ownerId)[0]!;
  await jobs.createDraft(ownerId, draft); await publisherService.confirm(draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
  const published = await publisherService.publish(draft.id, draft.id);
  const outbox = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: published.taskId } });
  const message = taskDispatchSchema.parse(outbox.payload);
  const corpora = new JobCorpusRepository(database); await corpora.freeze(ownerId, 'one', [draft.id], skillDictionaryV1);
  await assert.rejects(new JobIndexRepository(database).assertCorpusReady(ownerId, 'one', spec), /INDEX_NOT_READY/);
  const publisher = new ConfirmedTaskPublisher(baseline.rabbitmqUrl, topology, 5000), outboxConfig = outboxConfigSchema.parse({});
  assert.equal(await new OutboxPublisher(new OutboxStore(database, outboxConfig), publisher, identity, outboxConfig).runOnce(), 'published');
  await publisher.publish(message);
  const consumer = new TaskConsumer(baseline.rabbitmqUrl, topology, runtime.delivery);
  const consumed = await consumer.run('job-index', { maxMessages: 2, windowMs: 30_000 });
  assert.equal(consumed.acknowledged, 2); assert.equal(consumed.reason, 'limit');
  const task = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: published.taskId } });
  assert.equal(task.status, 'SUCCEEDED'); assert.equal(await db.taskAttempt.count({ where: { ownerId } }), 1);
  assert.equal((await jobs.findVersion(ownerId, draft.id))?.indexStatus, 'READY');
  assert.equal((await client.count(indexCollectionName(spec), { exact: true })).count, 1);
  await new JobIndexRepository(database).assertCorpusReady(ownerId, 'one', spec);
  await vector.switchAlias(spec, { signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 });
  await assert.rejects(vector.remove(spec, { signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 }));
  const wrong = { ...spec, dimensions: 4 };
  assert.notEqual(indexCollectionName(wrong), indexCollectionName(spec));
  await assert.rejects(vector.upsert(spec, [{ id: randomUUID(), vector: [1], payload: {} }],
    { signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 }));

  const nextSpec = { ...spec, indexVersion: 'fixture-index-v2', dimensions: 4 }; specs.push(nextSpec); save();
  await vector.ensure(nextSpec, { signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 });
  confirmed.add(indexCollectionName(nextSpec)); save();
  const target2 = { ...target, indexVersion: nextSpec.indexVersion }, run = randomUUID();
  const rebuilt = await publications.ensureIndex(ownerId, draft.id, run, target2);
  assert.equal(rebuilt.created, true); assert.equal((await publications.ensureIndex(ownerId, draft.id, run, target2)).taskId, rebuilt.taskId);
  assert.equal((await jobs.findVersion(ownerId, draft.id))?.indexStatus, 'PENDING');
  const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: rebuilt.taskId } });
  const dispatch = taskDispatchSchema.parse(event.payload);
  const claimed = await runtime.store.claim(ownerId, dispatch, 'job-index'); assert.equal(claimed.kind, 'acquired');
  if (claimed.kind !== 'acquired') assert.fail();
  const smallEmbedding = new EmbeddingExecutor({ embeddingVersion: embedding.embeddingVersion, dimensions: 4, provenance: 'synthetic',
    embed: async (texts, signal) => { const result = await new SyntheticEmbedding().embed(texts, signal);
      return { ...result, vectors: result.vectors.map(item => item.slice(0, 4)) }; } }, policy);
  const smallRuntime = createJobIndexDelivery(database, identity, smallEmbedding, vector, { allowSynthetic: true });
  const output = await smallRuntime.executor.execute(claimed.claim, AbortSignal.timeout(15_000),
    { reserve: usage => runtime.store.reserveUsage(claimed.claim, usage) });
  const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
    get(current, name, receiver) {
      if (name !== 'nodeArtifact') return Reflect.get(current, name, receiver);
      return new Proxy(current.nodeArtifact, { get(model, method, modelReceiver) {
        if (method !== 'create') return Reflect.get(model, method, modelReceiver);
        return (args: Prisma.NodeArtifactCreateArgs) => model.create({ ...args, data: { ...args.data, schemaVersion: 0 } });
      } });
    },
  }))) } };
  await assert.rejects(new TaskExecutionStore(broken, consumerConfigSchema.parse({})).completeJobIndex(claimed.claim, output));
  assert.equal((await jobs.findVersion(ownerId, draft.id))?.indexStatus, 'PENDING');
  assert.equal((await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: rebuilt.taskId } })).status, 'RUNNING');
  const replayOutput = await smallRuntime.executor.execute(claimed.claim, AbortSignal.timeout(15_000),
    { reserve: usage => runtime.store.reserveUsage(claimed.claim, usage) });
  assert.deepEqual(replayOutput, output); assert.equal((await client.count(indexCollectionName(nextSpec), { exact: true })).count, 1);
  // Retarget while an older execution holds a valid task fence: old completion must roll back READY.
  const newer = await publications.ensureIndex(ownerId, draft.id, randomUUID(), { ...target, indexVersion: 'fixture-index-v3' });
  assert.notEqual(newer.taskId, rebuilt.taskId);
  await assert.rejects(runtime.store.completeJobIndex(claimed.claim, output), /LEASE_LOST/);
  assert.equal((await jobs.findVersion(ownerId, draft.id))?.indexStatus, 'PENDING');
  await runtime.store.markExecutionStopped(claimed.claim);
  await db.jobIndexTask.update({ where: { ownerId, id: rebuilt.taskId }, data: { leaseUntil: new Date(0) } });
  assert.equal(await runtime.store.reconcile(ownerId, 'job-index', rebuilt.taskId, reconciliationConfigSchema.parse({})), 'handler-unavailable');
  assert.equal(await runtime.store.reconcile(ownerId, 'job-index', rebuilt.taskId, reconciliationConfigSchema.parse({}), 'job-index'), 'recovered');
  await assert.rejects(runtime.store.completeJobIndex(claimed.claim, output), /LEASE_LOST/);
  assert.equal(jobIndexInputSnapshotSchema.parse(task.inputSnapshot).kind, 'job-index');

  // Fail after the actual point write, as with a lost acknowledgement, and recover the same task.
  const retryTask = await publications.ensureIndex(ownerId, draft.id, randomUUID(), target2);
  const retryEvent = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: retryTask.taskId } });
  class LostReplyVector extends JobIndexVector {
    private first = true;
    override async upsert(...args: Parameters<JobIndexVector['upsert']>) {
      await super.upsert(...args);
      if (this.first) { this.first = false; throw new TaskFailure('UPSTREAM_5XX'); }
    }
  }
  const retryVector = new LostReplyVector({ url: qdrant.config.qdrantUrl, apiKey: qdrant.config.qdrantApiKey }, qdrant.verify);
  const retryRuntime = createJobIndexDelivery(database, identity, smallEmbedding, retryVector, { allowSynthetic: true });
  assert.equal(await retryRuntime.delivery.handle(taskDispatchSchema.parse(retryEvent.payload), AbortSignal.timeout(30_000)), 'ack');
  const waiting = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: retryTask.taskId } });
  assert.equal(waiting.status, 'RETRY_WAIT');
  assert.equal((await jobs.findVersion(ownerId, draft.id))?.indexStatus, 'PENDING');
  assert.ok(waiting.retryAt && waiting.retryAt.getTime() > Date.now());
  const resumedEvent = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: retryTask.taskId,
    payload: { path: ['dispatchGeneration'], equals: waiting.generation } } });
  // Scheduling delays are already verified in retry.test; advance only this fixture's retry gate.
  await db.jobIndexTask.update({ where: { ownerId, id: retryTask.taskId }, data: { retryAt: new Date(0) } });
  assert.equal(await retryRuntime.delivery.handle(taskDispatchSchema.parse(resumedEvent.payload), AbortSignal.timeout(30_000)), 'ack');
  const completed = await db.jobIndexTask.findFirstOrThrow({ where: { ownerId, id: retryTask.taskId } });
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(budgetUsageSchema.parse(completed.budgetUsage).modelCalls, 2);
  assert.equal(budgetUsageSchema.parse(completed.budgetUsage).tokens, 2 * policy.inputTokenReservation);
  assert.equal(await db.taskAttempt.count({ where: { ownerId, jobIndexTaskId: retryTask.taskId } }), 2);
  assert.equal((await client.count(indexCollectionName(nextSpec), { exact: true })).count, 1);
  await new JobIndexRepository(database).assertCorpusReady(ownerId, 'one', nextSpec);
  await vector.switchAlias(nextSpec, { signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 });
  assert.equal((await vector.listAliases({ signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 }))
    .find(item => item.collection_name === indexCollectionName(nextSpec))?.collection_name, indexCollectionName(nextSpec));
  assert.equal((await client.count(indexCollectionName(spec), { exact: true })).count, 1);
});
