import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { RubricService } from '../../src/modules/rubrics/rubric.service.js';
import { syntheticRubric } from '../support/job-inputs.js';
import { dimensionIds } from '../../src/contracts/jobs.js';

await test('S2.2 rubric import is immutable and idempotent; exact loading requires all six dimensions and levels', { timeout: 30_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const ownerId = randomUUID(), repository = new JobRepository(database);
  const service = new RubricService({ getOwnerId: () => Promise.resolve(ownerId) }, repository);
  await db.owner.create({ data: { id: ownerId } });
  t.after(async () => {
    try {
      await ownedPostgres(); await db.rubricVersion.deleteMany({ where: { ownerId } }); await db.owner.delete({ where: { id: ownerId } });
      assert.equal(await db.rubricVersion.count({ where: { ownerId } }), 0);
    } finally { await database.onModuleDestroy(); }
  });
  const content = syntheticRubric();
  await assert.rejects(service.import(content), /TEST_RUBRIC_NOT_ALLOWED/);
  const imported = await Promise.all([service.import(content, true), service.import(content, true)]);
  assert.equal(imported.filter(value => value.replay).length, 1);
  assert.equal(await db.rubricVersion.count({ where: { ownerId } }), 1);
  await assert.rejects(service.load(content.version), /TEST_RUBRIC_NOT_ALLOWED/);
  for (const dimension of dimensionIds) {
    const value = await service.dimension(content.version, dimension, true);
    assert.deepEqual(value.levels.map(level => level.level), [1, 2, 3, 4, 5]);
    assert.equal(value.contentHash, imported[0]!.contentHash);
  }
  const changed = structuredClone(content); changed.dimensions[0]!.levels[0]!.behavior = '不同内容';
  await assert.rejects(service.import(changed, true), /RUBRIC_VERSION_CONFLICT/);
  assert.deepEqual((await service.load(content.version, true)).content, content);
  const invalid = syntheticRubric(); invalid.dimensions[0]!.levels.pop();
  await assert.rejects(service.import(invalid, true));
  await db.rubricVersion.create({ data: { ownerId, version: invalid.version, content: invalid, contentHash: 'a'.repeat(64) } });
  await assert.rejects(service.load(invalid.version, true)); // malformed persisted JSON must also fail closed
  const foreign = new RubricService({ getOwnerId: () => Promise.resolve(randomUUID()) }, repository);
  await assert.rejects(foreign.load(content.version, true), /RUBRIC_NOT_FOUND/);
});
