import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { jdDocument } from '../src/modules/jobs/evidence.js';
import { chunkJob, indexCollectionName, indexPointId, indexAlias } from '../src/modules/recall/job-chunks.js';
import { indexCollectionSchema, jobIndexCompletionSchema } from '../src/contracts/job-index.js';

await test('S2.3 index chunks preserve UTF-16 ranges and stable point identities across retries', () => {
  const id = randomUUID(), text = `${'中'.repeat(999)}🚀${'文'.repeat(1001)}`, document = jdDocument(id, text);
  const chunks = chunkJob(document);
  assert.equal(chunks.length, 3); assert.equal(chunks[0]!.end, 999);
  assert.equal(chunks.map(chunk => chunk.text).join(''), text);
  assert.deepEqual(chunkJob(document), chunks);
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text);
    assert.equal(indexPointId(id, chunk.chunkId, 'model-v1'), indexPointId(id, chunk.chunkId, 'model-v1'));
    assert.notEqual(indexPointId(id, chunk.chunkId, 'model-v1'), indexPointId(id, chunk.chunkId, 'model-v2'));
  }
  assert.throws(() => chunkJob({ ...document, textHash: 'a'.repeat(64) }));
});

await test('S2.3 collection names separate dimensions, versions and owners; completion forbids duplicate points', () => {
  const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index',
    ownerId: randomUUID(), embeddingVersion: 'model-v1', indexVersion: 'index-v1', dimensions: 8, provenance: 'synthetic',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1' });
  const name = indexCollectionName(spec);
  assert.notEqual(name, indexCollectionName({ ...spec, dimensions: 4 }));
  assert.notEqual(name, indexCollectionName({ ...spec, indexVersion: 'index-v2' }));
  assert.notEqual(name, indexCollectionName({ ...spec, ownerId: randomUUID() }));
  assert.notEqual(indexAlias(spec.ownerId), indexAlias(randomUUID()));
  const point = randomUUID();
  assert.equal(jobIndexCompletionSchema.safeParse({ schemaVersion: 1, kind: 'job-index', inputHash: 'a'.repeat(64),
    completedUnits: 2, collection: name, spec, points: [point, point] }).success, false);
});
