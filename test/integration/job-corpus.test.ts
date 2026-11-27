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
import { JobPublicationService } from '../../src/modules/jobs/job-publication.service.js';
import { CorpusImportService } from '../../src/modules/recall/corpus-import.service.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { generateSyntheticJobs, syntheticCorpusVersion } from '../../src/modules/recall/synthetic-corpus.js';
import { jobIndexTargetSchema } from '../../src/contracts/job-publication.js';

await test('S2.3 corpus imports 100 published JDs, resumes and freezes owner-scoped dictionary snapshots', { timeout: 180_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const ownerId = randomUUID(), other = randomUUID(), owners = [ownerId, other];
  mkdirSync('data/s23-corpus-runs', { recursive: true });
  const manifestPath = `data/s23-corpus-runs/${ownerId}.json`;
  const save = (cleaned: boolean) => writeFileSync(manifestPath, JSON.stringify({ ownerIds: owners, cleaned }));
  save(false);
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const id of owners) {
        await db.$transaction(async tx => {
          await tx.jobCorpusVersion.deleteMany({ where: { ownerId: id } });
          await tx.outboxEvent.deleteMany({ where: { ownerId: id } });
          await tx.jobIndexTarget.deleteMany({ where: { ownerId: id } });
          await tx.jobIndexTask.deleteMany({ where: { ownerId: id } });
          await tx.jobVersion.deleteMany({ where: { ownerId: id } });
          await tx.job.deleteMany({ where: { ownerId: id } });
          await tx.owner.deleteMany({ where: { id } });
        });
        assert.equal(await db.job.count({ where: { ownerId: id } }), 0);
        assert.equal(await db.jobCorpusVersion.count({ where: { ownerId: id } }), 0);
      }
      save(true);
      t.diagnostic('Exact-run synthetic owners, corpus, jobs, targets, tasks and Outbox removed; official rubric untouched');
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of owners) await db.owner.create({ data: { id } });
  const jobs = new JobRepository(database), corpora = new JobCorpusRepository(database);
  const identity = { getOwnerId: () => Promise.resolve(ownerId) };
  const publications = new JobPublicationRepository(database);
  // Test-only target on fresh isolated owner; CLI rejects this and no official index is registered.
  const target = jobIndexTargetSchema.parse({ embeddingVersion: 'fixture-only-v1', indexVersion: 'fixture-only-v1',
    chunkerVersion: 'jd-text-v1', componentVersion: 'fixture-only-v1', budget: { maxAttempts: 3, maxModelCalls: 0,
      maxTokens: 0, maxCostMicros: 0, currency: 'CNY', maxDurationMs: 30_000 } });
  const service = new CorpusImportService(identity, jobs, new JobPublicationService(identity, publications, target), corpora);
  const drafts = generateSyntheticJobs(ownerId);
  await jobs.createDraft(ownerId, drafts[0]!);
  await assert.rejects(corpora.freeze(ownerId, 'draft-rejected', [drafts[0]!.id], skillDictionaryV1), /NOT_VISIBLE_OR_PUBLISHED/);
  const imported = await service.importSynthetic(), ids = imported.manifest.members.map(member => member.jobVersionId);
  assert.equal(imported.manifest.members.length, 100); assert.equal(imported.replay, false);
  assert.equal(await db.jobVersion.count({ where: { ownerId, status: 'PUBLISHED', indexStatus: 'PENDING' } }), 100);
  assert.equal(await db.jobIndexTask.count({ where: { ownerId, status: 'QUEUED' } }), 100);
  assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 100);
  const replay = await service.importSynthetic();
  assert.equal(replay.contentHash, imported.contentHash); assert.equal(replay.replay, true);
  assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 100);
  assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 100);
  await assert.rejects(corpora.freeze(other, 'foreign', ids, skillDictionaryV1), /NOT_VISIBLE_OR_PUBLISHED/);
  assert.equal(await corpora.load(other, syntheticCorpusVersion), null);
  await assert.rejects(corpora.freeze(ownerId, 'duplicates', [ids[0], ids[0]], skillDictionaryV1), /DUPLICATE/);
  await assert.rejects(corpora.freeze(ownerId, syntheticCorpusVersion, ids.slice(1), skillDictionaryV1), /CONFLICT/);
  await assert.rejects(db.jobCorpusVersion.update({ where: { ownerId_version: { ownerId, version: syntheticCorpusVersion } }, data: { visibility: 'public' } }));
  const later = structuredClone(skillDictionaryV1); later.version = 'skills-zh-v2';
  const ts = later.entries.find(entry => entry.name === 'typescript')!; ts.name = 'typescript-new'; ts.aliases.push('typescript');
  const second = await corpora.freeze(ownerId, 'second-dictionary', ids, later);
  assert.ok(second.manifest.members.some(member => member.skills.includes('typescript-new')));
  assert.deepEqual(await corpora.load(ownerId, syntheticCorpusVersion), { manifest: imported.manifest, contentHash: imported.contentHash });
  await jobs.editDraft(ownerId, drafts[0]!.id, { kind: 'metadata', metadata: { title: '新的草稿', city: null, level: null, skills: ['different'] } });
  assert.deepEqual(await corpora.load(ownerId, syntheticCorpusVersion), { manifest: imported.manifest, contentHash: imported.contentHash });
});
