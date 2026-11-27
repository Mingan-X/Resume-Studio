import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobCorpusRepository } from '../../src/infrastructure/jobs/corpus.repository.js';
import { CandidateRepository } from '../../src/infrastructure/jobs/candidate.repository.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';
import { recallConfigSchema, recallResultSchema } from '../../src/contracts/recall.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { jobDraft } from '../support/job-inputs.js';
import { analysisInput } from '../support/task-inputs.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import type { Prisma } from '../../src/generated/prisma/client.js';

await test('S2.3 candidate sets freeze once under a live fence, preserve ranks and reject mutation/foreign members', { timeout: 90_000 }, async t => {
  await ownedPostgres(); const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const owners = [randomUUID(), randomUUID()], ownerId = owners[0]!, other = owners[1]!;
  mkdirSync('data/s23-candidate-runs', { recursive: true }); const path = `data/s23-candidate-runs/${ownerId}.json`;
  const save = (cleaned = false) => writeFileSync(path, JSON.stringify({ owners, cleaned })); save();
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const id of owners) await db.$transaction(async tx => {
        await tx.candidateSet.deleteMany({ where: { ownerId: id } });
        await tx.nodeArtifact.deleteMany({ where: { ownerId: id } }); await tx.consumerReceipt.deleteMany({ where: { ownerId: id } });
        await tx.taskEvent.deleteMany({ where: { ownerId: id } }); await tx.taskAttempt.deleteMany({ where: { ownerId: id } });
        await tx.outboxEvent.deleteMany({ where: { ownerId: id } }); await tx.analysisTask.deleteMany({ where: { ownerId: id } });
        await tx.jobCorpusVersion.deleteMany({ where: { ownerId: id } }); await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } });
        await tx.jobIndexTask.deleteMany({ where: { ownerId: id } }); await tx.jobVersion.deleteMany({ where: { ownerId: id } });
        await tx.job.deleteMany({ where: { ownerId: id } }); await tx.owner.deleteMany({ where: { id } });
      }); save(true);
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of owners) await db.owner.create({ data: { id } });
  const jobs = new JobRepository(database), publication = new JobPublicationRepository(database), draft = jobDraft(ownerId);
  const target = jobIndexTargetSchema.parse({ embeddingVersion: 'fixture-v1', indexVersion: 'fixture-index-v1',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1', budget: { maxAttempts: 3, maxModelCalls: 0,
      maxTokens: 0, maxCostMicros: 0, currency: 'CNY', maxDurationMs: 120_000 } });
  await jobs.createDraft(ownerId, draft); await publication.confirm(ownerId, draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
  await publication.publish(ownerId, draft.id, randomUUID(), target);
  const corpus = await new JobCorpusRepository(database).freeze(ownerId, 'candidate-corpus-v1', [draft.id], skillDictionaryV1);
  const repository = new CandidateRepository(database), execution = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
  const createClaim = async () => {
    const input = analysisInput(); input.budget.maxDurationMs = 120_000; input.embeddingVersion = target.embeddingVersion;
    const task = await new TaskCreationService({ getOwnerId: () => Promise.resolve(ownerId) }, new TaskRepository(database)).createAnalysis(randomUUID(), input);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: task.taskId } });
    const result = await execution.claim(ownerId, taskDispatchSchema.parse(event.payload));
    assert.equal(result.kind, 'acquired'); if (result.kind !== 'acquired') assert.fail(); return result.claim;
  };
  const query = { schemaVersion: 1, corpusVersion: corpus.manifest.version, skills: ['TS'], summary: '合成简历 synthetic@example.test' };
  const recall = recallResultSchema.parse({ schemaVersion: 1, corpusVersion: corpus.manifest.version, corpusHash: corpus.contentHash,
    config: recallConfigSchema.parse({ version: 'hybrid-rrf-v1', vectorFailure: 'keyword' }), embeddingVersion: target.embeddingVersion,
    indexSpec: { schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId, embeddingVersion: target.embeddingVersion,
      indexVersion: target.indexVersion, dimensions: 8, provenance: 'synthetic', chunkerVersion: target.chunkerVersion, componentVersion: target.componentVersion },
    candidates: [{ jobId: draft.jobId, jobVersionId: draft.id, rank: 1, rrfScore: 1 / 61, sources: [{ source: 'keyword', rank: 1 }] }],
    degraded: true, degradationReason: 'INDEX_NOT_READY' });
  const claim = await createClaim();
  const [set, repeated] = await Promise.all([repository.freeze(claim, query, recall), repository.freeze(claim, query, recall)]);
  assert.deepEqual(repeated, set); assert.equal(await db.candidateSet.count({ where: { ownerId } }), 1);
  assert.equal(await db.candidate.count({ where: { ownerId } }), 1); assert.doesNotMatch(JSON.stringify(set), /synthetic@example/);
  assert.deepEqual(await repository.load(ownerId, claim.message.taskId), set); assert.equal(await repository.load(other, claim.message.taskId), null);
  await assert.rejects(repository.freeze(claim, query, { ...recall, candidates: [] }), /CANDIDATE_SET_CONFLICT/);
  await assert.rejects(repository.freeze({ ...claim, fenceToken: claim.fenceToken + 1n }, query, recall), /LEASE_LOST/);
  await assert.rejects(db.candidateSet.update({ where: { id: set.id }, data: { contentHash: 'a'.repeat(64) } }));
  await assert.rejects(db.candidate.update({ where: { setId_jobVersionId: { setId: set.id, jobVersionId: draft.id } }, data: { rank: 2 } }));
  await assert.rejects(db.candidate.deleteMany({ where: { setId: set.id } }));
  await assert.rejects(db.candidate.create({ data: { ownerId, setId: set.id, jobVersionId: draft.id, rank: 2, content: { ...recall.candidates[0]!, rank: 2 } } }));
  await assert.rejects(db.jobVersion.delete({ where: { ownerId, id: draft.id } }));
  const next = await createClaim();
  await assert.rejects(repository.freeze(next, { ...query, city: '不匹配城市' }, recall), /CANDIDATE_NOT_VISIBLE/);
  await assert.rejects(repository.freeze(next, query, { ...recall, corpusHash: 'a'.repeat(64) }), /CORPUS_HASH_MISMATCH/);
  await assert.rejects(repository.freeze(next, query, { ...recall, candidates: [{ ...recall.candidates[0]!, jobVersionId: randomUUID() }] }), /CANDIDATE_NOT_VISIBLE/);
  const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
    get(current, name, receiver) {
      if (name !== 'candidate') return Reflect.get(current, name, receiver);
      return new Proxy(current.candidate, { get(model, method, modelReceiver) {
        if (method !== 'createMany') return Reflect.get(model, method, modelReceiver);
        return (_args: Prisma.CandidateCreateManyArgs) => model.createMany({ data: [{ ownerId, setId: randomUUID(), jobVersionId: draft.id, rank: 1, content: recall.candidates[0]! }] });
      } });
    },
  }))) } };
  await assert.rejects(new CandidateRepository(broken).freeze(next, query, recall));
  assert.equal(await repository.load(ownerId, next.message.taskId), null);
  const empty = await repository.freeze(next, query, { ...recall, candidates: [] });
  assert.equal(empty.content.recall.candidates.length, 0);
  await db.analysisTask.update({ where: { ownerId, id: next.message.taskId }, data: { cancelRequested: true } });
  await assert.rejects(repository.freeze(next, query, { ...recall, candidates: [] }), /LEASE_LOST/);
});
