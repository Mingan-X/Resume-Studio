import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cleanIndexCollections } from './support/index-cleanup.js';
import { indexCollectionSchema } from '../src/contracts/job-index.js';
import { indexCollectionName } from '../src/modules/recall/job-chunks.js';
import { TaskFailure } from '../src/infrastructure/consumer/failure.js';

await test('S2.3 index cleanup reconciles transient read/delete replies inside the same bounded window', async () => {
  const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId: randomUUID(),
    embeddingVersion: 'fixture-v1', indexVersion: 'fixture-v1', dimensions: 8, provenance: 'synthetic', chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1' });
  const name = indexCollectionName(spec); let reads = 0, removes = 0, verified = 0, exists = true;
  const deadlines: number[] = [];
  const vector = { listAliases: () => Promise.resolve([]), removeAlias: () => Promise.resolve(),
    exists: (_raw: unknown, call: { deadline: number }) => {
      deadlines.push(call.deadline);
      if (++reads === 1) return Promise.reject(new TaskFailure('DEPENDENCY_UNAVAILABLE'));
      return Promise.resolve(exists);
    }, remove: () => { removes++; exists = false; return Promise.reject(new TaskFailure('UPSTREAM_TIMEOUT')); } };
  await cleanIndexCollections([spec], new Set([name]), vector, () => { verified++; return Promise.resolve(); }, 1500);
  assert.equal(removes, 1); assert.equal(reads, 3); assert.equal(new Set(deadlines).size, 1); assert.ok(verified >= reads);
  removes = 0;
  await assert.rejects(cleanIndexCollections([spec], new Set([name]), vector, () => Promise.reject(new Error('ownership')), 100), /ownership/);
  assert.equal(removes, 0);
  await assert.rejects(cleanIndexCollections([spec], new Set([name]), { ...vector, exists: () => Promise.reject(new TaskFailure('INPUT_INVALID')) }, () => Promise.resolve(), 100), /INPUT_INVALID/);
  await assert.rejects(cleanIndexCollections([spec], new Set([name]), { ...vector, exists: () => Promise.reject(new TaskFailure('DEPENDENCY_UNAVAILABLE')) }, () => Promise.resolve(), 50), /CLEANUP_UNCONFIRMED/);
});
