import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobDraftService } from '../../src/modules/jobs/job-draft.service.js';
import { validateJobRequirements } from '../../src/modules/jobs/evidence.js';

await test('S2.2 draft editing preserves exact evidence and forks published versions atomically', { timeout: 60_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const repository = new JobRepository(database), owners: string[] = [];
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.jobVersion.deleteMany({ where: { ownerId } }); await tx.job.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        assert.equal(await db.jobRequirement.count({ where: { ownerId } }), 0);
      }
      t.diagnostic('T3 exact-run draft jobs, versions, requirements and owners removed');
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of [randomUUID(), randomUUID()]) { await db.owner.create({ data: { id } }); owners.push(id); }
  const ownerId = owners[0]!, other = owners[1]!;
  const service = new JobDraftService({ getOwnerId: () => Promise.resolve(ownerId) }, repository);
  const foreign = new JobDraftService({ getOwnerId: () => Promise.resolve(other) }, repository);
  const original = await service.create({ title: '合成测试工程师', city: null, level: null, skills: ['测试'], body: '自动化测试经验，工程交付。' });
  const requirement = { stableId: 'testing', dimension: 'engineering', kind: 'SOFT', description: '自动化测试实践',
    threshold: null, weight: 1, priority: 1, sourceRef: { sourceType: 'JD', sourceVersionId: original.id,
      blockId: original.document.blocks[0]!.id, start: 0, end: 5, quote: '自动化测试' } };
  await t.test('creation stores normalized text and explicit equal weights without creating an index task', async () => {
    assert.equal(original.version, 1); assert.equal(original.status, 'DRAFT');
    assert.equal(original.requirements.length, 0); assert.equal(original.dimensionWeights.length, 6);
    assert.ok(original.dimensionWeights.every(item => item.weight === 1));
    assert.equal(await db.jobIndexTask.count({ where: { ownerId } }), 0);
    assert.equal(await db.outboxEvent.count({ where: { ownerId } }), 0);
    await assert.rejects(service.create({ title: 'spoof', body: 'data', city: null, level: null, skills: [], ownerId: other }));
  });
  await t.test('requirements can be added, changed and removed, with owner and exact source validation', async () => {
    const added = await service.edit(original.id, { kind: 'requirement-upsert', requirement });
    assert.equal(added.id, original.id); assert.equal(added.requirements.length, 1);
    const changed = await service.edit(original.id, { kind: 'requirement-upsert', requirement: { ...requirement, kind: 'HARD', weight: 2 } });
    assert.equal(changed.requirements[0]!.kind, 'HARD'); assert.equal(changed.requirements[0]!.weight, 2);
    await assert.rejects(foreign.edit(original.id, { kind: 'requirement-delete', stableId: 'testing' }), /JOB_NOT_FOUND/);
    for (const patch of [{ quote: '伪造的内容' }, { sourceVersionId: randomUUID() }, { blockId: randomUUID() }, { start: 100, end: 105 }]) {
      await assert.rejects(service.edit(original.id, { kind: 'requirement-upsert', requirement: { ...requirement, sourceRef: { ...requirement.sourceRef, ...patch } } }));
    }
    const removed = await service.edit(original.id, { kind: 'requirement-delete', stableId: requirement.stableId });
    assert.equal(removed.requirements.length, 0);
    await service.edit(original.id, { kind: 'requirement-upsert', requirement });
  });
  await t.test('body editing rebinds unchanged ranges, rejects invalidated evidence and resets confirmations', async () => {
    await db.jobVersion.update({ where: { id: original.id, ownerId }, data: { hardRequirementsConfirmed: true, weightsConfirmed: true } });
    const edited = await service.edit(original.id, { kind: 'body', body: original.document.blocks[0]!.text + '\r\n协作。' });
    assert.notEqual(edited.document.textHash, original.document.textHash);
    assert.equal(edited.document.blocks[0]!.text.endsWith('\n协作。'), true);
    assert.equal(edited.hardRequirementsConfirmed, false); assert.equal(edited.weightsConfirmed, false);
    validateJobRequirements(ownerId, ownerId, edited.document, edited.requirements);
    await assert.rejects(service.edit(original.id, { kind: 'body', body: '移除所有原证据' }), /JD_EDIT_INVALIDATES_REQUIREMENTS/);
    assert.deepEqual(await repository.findVersion(ownerId, original.id), edited);
    await assert.rejects(service.edit(original.id, { kind: 'requirement-upsert', requirement })); // stale block hash
  });
  await t.test('editing a published version creates distinct sequential drafts with rebound evidence and leaves history intact', async () => {
    await db.jobVersion.update({ where: { ownerId, id: original.id }, data: { status: 'PUBLISHED', contentHash: 'a'.repeat(64),
      publishedAt: new Date(), hardRequirementsConfirmed: true, weightsConfirmed: true, indexStatus: 'PENDING' } });
    const published = await repository.findVersion(ownerId, original.id);
    const [first, second] = await Promise.all(['甲', '乙'].map(suffix => service.edit(original.id, {
      kind: 'metadata', metadata: { title: `合成岗位${suffix}`, city: null, level: null, skills: [] },
    })));
    assert.deepEqual([first!.version, second!.version].sort(), [2, 3]);
    assert.notEqual(first!.id, second!.id);
    for (const draft of [first!, second!]) {
      assert.equal(draft.status, 'DRAFT'); assert.equal(draft.requirements[0]!.stableId, requirement.stableId);
      assert.equal(draft.requirements[0]!.sourceRef.sourceVersionId, draft.id);
      assert.equal(draft.requirements[0]!.sourceRef.quote, requirement.sourceRef.quote);
      validateJobRequirements(ownerId, ownerId, draft.document, draft.requirements);
    }
    assert.deepEqual(await repository.findVersion(ownerId, original.id), published);
    const before = await db.jobVersion.count({ where: { ownerId } });
    await assert.rejects(service.edit(original.id, { kind: 'body', body: '破坏引用' }), /JD_EDIT_INVALIDATES_REQUIREMENTS/);
    assert.equal(await db.jobVersion.count({ where: { ownerId } }), before);
    assert.deepEqual(await repository.findVersion(ownerId, original.id), published);
  });
});
