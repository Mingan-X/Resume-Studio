import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobPublicationService } from '../../src/modules/jobs/job-publication.service.js';
import { JobCorpusRepository } from '../../src/infrastructure/jobs/corpus.repository.js';
import { KeywordRecallRepository } from '../../src/infrastructure/jobs/keyword-recall.repository.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { generateSyntheticJobs } from '../../src/modules/recall/synthetic-corpus.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';

await test('S2.3 keyword SQL recall caps, orders, isolates owners and respects frozen published membership', { timeout: 120_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const ownerId = randomUUID(), other = randomUUID();
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const id of [ownerId, other]) await db.$transaction(async tx => {
        await tx.jobCorpusVersion.deleteMany({ where: { ownerId: id } });
        await tx.outboxEvent.deleteMany({ where: { ownerId: id } });
        await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } });
        await tx.jobIndexTask.deleteMany({ where: { ownerId: id } });
        await tx.jobVersion.deleteMany({ where: { ownerId: id } });
        await tx.job.deleteMany({ where: { ownerId: id } });
        await tx.owner.deleteMany({ where: { id } });
      });
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of [ownerId, other]) await db.owner.create({ data: { id } });
  const jobs = new JobRepository(database), corpora = new JobCorpusRepository(database), recall = new KeywordRecallRepository(database);
  const identity = { getOwnerId: () => Promise.resolve(ownerId) };
  const target = jobIndexTargetSchema.parse({ embeddingVersion: 'fixture-only-v1', indexVersion: 'fixture-only-v1',
    chunkerVersion: 'jd-text-v1', componentVersion: 'fixture-only-v1', budget: { maxAttempts: 3, maxModelCalls: 0,
      maxTokens: 0, maxCostMicros: 0, currency: 'CNY', maxDurationMs: 30_000 } });
  const publisher = new JobPublicationService(identity, new JobPublicationRepository(database), target);
  const drafts = generateSyntheticJobs(ownerId).slice(0, 60);
  for (const draft of drafts) {
    await jobs.createDraft(ownerId, draft);
    await publisher.confirm(draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
    await publisher.publish(draft.id, draft.id);
  }
  await corpora.freeze(ownerId, 'all', drafts.map(draft => draft.id), skillDictionaryV1);
  const query = { schemaVersion: 1, corpusVersion: 'all', skills: skillDictionaryV1.entries.map(entry => entry.name), summary: '' };
  const first = await recall.recall(ownerId, query);
  assert.equal(first.candidates.length, 50);
  const expected = [...drafts].sort((a, b) => a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0).slice(0, 50);
  assert.deepEqual(first.candidates.map(candidate => candidate.jobVersionId), expected.map(draft => draft.id));
  assert.deepEqual(first.candidates.map(candidate => candidate.rank), Array.from({ length: 50 }, (_, index) => index + 1));
  assert.ok(first.candidates.every(candidate => candidate.source === 'keyword' && candidate.matchedSkills.length === 3));
  assert.deepEqual(await recall.recall(ownerId, query), first);
  const limited = await recall.recall(ownerId, query, { version: 'keyword-overlap-v1', limit: 2 });
  assert.deepEqual(limited.candidates, first.candidates.slice(0, 2));
  const aliased = await recall.recall(ownerId, { ...query, skills: ['ＴＳ', 'TypeScript'] });
  assert.equal(aliased.candidates.length, 10);
  assert.ok(aliased.candidates.every(candidate => candidate.matchedSkills.join() === 'typescript'));
  const city = await recall.recall(ownerId, { ...query, city: '北京' });
  assert.equal(city.candidates.length, 12);
  assert.ok(city.candidates.every(candidate => drafts.find(draft => draft.id === candidate.jobVersionId)?.city === '北京'));
  assert.equal((await recall.recall(ownerId, { ...query, skills: [] })).candidates.length, 0);
  assert.equal((await recall.recall(ownerId, { ...query, skills: ['不存在技能'] })).candidates.length, 0);
  await assert.rejects(recall.recall(other, query), /CORPUS_NOT_FOUND/);
  await corpora.freeze(ownerId, 'one', [drafts[0]!.id], skillDictionaryV1);
  const revised = await jobs.editDraft(ownerId, drafts[0]!.id, { kind: 'metadata',
    metadata: { title: '新发布版本', city: null, level: null, skills: ['TypeScript'] } });
  await publisher.confirm(revised.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
  await publisher.publish(revised.id, revised.id);
  assert.deepEqual((await recall.recall(ownerId, { ...query, corpusVersion: 'one' })).candidates.map(candidate => candidate.jobVersionId), [drafts[0]!.id]);
  // Simulate authorized version removal. The historical manifest remains, but SQL must not return a missing version.
  await db.$transaction(async tx => {
    await tx.jobIndexTarget.deleteMany({ where: { ownerId, jobVersionId: drafts[0]!.id } });
    await tx.jobIndexTask.deleteMany({ where: { ownerId, jobVersionId: drafts[0]!.id } });
    await tx.jobVersion.delete({ where: { ownerId, id: drafts[0]!.id } });
  });
  assert.equal((await recall.recall(ownerId, { ...query, corpusVersion: 'one' })).candidates.length, 0);
});
