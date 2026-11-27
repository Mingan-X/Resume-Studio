import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ScoringPolicyRepository } from '../../src/infrastructure/tasks/scoring-policy.repository.js';
import { scoringPolicy } from '../support/scoring-inputs.js';

await test('S2.5 scoring policy versions are owner scoped, immutable, hash validated and idempotently imported', { timeout: 60000 }, async t => {
  await ownedPostgres(); const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client, owners = [randomUUID(), randomUUID()];
  t.after(async () => { try { await ownedPostgres(); for (const ownerId of owners) await db.$transaction(async tx => {
    await tx.scoringPolicy.deleteMany({ where: { ownerId } }); await tx.owner.deleteMany({ where: { id: ownerId } });
  }); } finally { await database.onModuleDestroy(); } });
  await db.owner.createMany({ data: owners.map(id => ({ id })) });
  const repository = new ScoringPolicyRepository(database), input = scoringPolicy();
  const results = await Promise.all([repository.import(owners[0]!, input), repository.import(owners[0]!, input)]);
  assert.equal(results.filter(item => item.replay).length, 1); assert.equal(results[0]?.contentHash, results[1]?.contentHash);
  assert.equal((await repository.load(owners[0]!, input.version))?.contentHash, results[0]?.contentHash);
  assert.equal(await repository.load(owners[1]!, input.version), null);
  await assert.rejects(repository.import(owners[0]!, { ...input, verdictCoefficients: { ...input.verdictCoefficients, partial: 4000 } }), /POLICY_CONFLICT/);
  await assert.rejects(db.scoringPolicy.update({ where: { ownerId_version: { ownerId: owners[0]!, version: input.version } }, data: { contentHash: 'a'.repeat(64) } }));
  await assert.rejects(repository.import(randomUUID(), input));
  assert.equal(await db.scoringPolicy.count({ where: { ownerId: owners[0]! } }), 1);
});
