import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RecallService } from '../src/modules/recall/recall.service.js';
import { EmbeddingExecutor } from '../src/modules/embeddings/embedding-executor.js';
import { EmbeddingFailure } from '../src/modules/embeddings/embedding.port.js';
import { SyntheticEmbedding } from './support/synthetic-embedding.js';
import { indexCollectionSchema, indexPointPayloadSchema } from '../src/contracts/job-index.js';
import { corpusManifestSchema } from '../src/contracts/job-corpus.js';
import { keywordRecallConfigSchema } from '../src/contracts/recall.js';
import { skillDictionaryV1 } from '../src/modules/recall/skills.js';
import { jdDocument } from '../src/modules/jobs/evidence.js';
import { requestHash } from '../src/modules/tasks/request-hash.js';
import { indexCollectionName } from '../src/modules/recall/job-chunks.js';
import { TaskFailure } from '../src/infrastructure/consumer/failure.js';

const policy = { singleTimeoutMs: 100, totalTimeoutMs: 1000, maxAttempts: 2, retryBaseMs: 1, retryCapMs: 2,
  maxConcurrent: 1, inputTokenReservation: 2048, costReservationMicros: 10, maxTokens: 4096, maxCostMicros: 20, currency: 'CNY' };
function fixture() {
  const ownerId = randomUUID(), embedding = new EmbeddingExecutor(new SyntheticEmbedding(), policy);
  const spec = indexCollectionSchema.parse({ schemaVersion: 1, project: 'resume-studio', kind: 'job-index', ownerId,
    embeddingVersion: embedding.embeddingVersion, indexVersion: 'fixture-index-v1', dimensions: 8, provenance: 'synthetic',
    chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1' });
  const versions = Array.from({ length: 3 }, () => { const id = randomUUID(); return { id, jobId: randomUUID(), contentHash: 'a'.repeat(64), document: jdDocument(id, '合成技能岗位') }; });
  const manifest = corpusManifestSchema.parse({ schemaVersion: 1, ownerId, version: 'corpus-v1', visibility: 'private', dictionary: skillDictionaryV1,
    members: versions.map(version => ({ jobVersionId: version.id, contentHash: version.contentHash, skills: ['typescript'] })).sort((a, b) => a.jobVersionId < b.jobVersionId ? -1 : 1) });
  const corpus = { manifest, contentHash: requestHash(manifest) };
  const candidates = versions.map((version, index) => ({ jobId: version.jobId, jobVersionId: version.id, source: 'keyword' as const, rank: index + 1, matchedSkills: ['typescript'] }));
  const keyword = { recall: () => Promise.resolve({ corpusVersion: 'corpus-v1', corpusHash: corpus.contentHash,
    config: keywordRecallConfigSchema.parse({ version: 'keyword-overlap-v1' }), dictionaryVersion: skillDictionaryV1.version, candidates }) };
  const indexes = { assertCorpusReady: () => Promise.resolve({ corpus, collection: indexCollectionName(spec) }),
    visibleVersions: () => Promise.resolve(versions), validCandidates: () => Promise.resolve(candidates.map(({ jobId, jobVersionId }) => ({ jobId, jobVersionId }))) };
  const points = [versions[1]!, versions[1]!, versions[0]!].map((version, index) => ({ id: randomUUID(), score: 0.9 - index * 0.1,
    payload: indexPointPayloadSchema.parse({ schemaVersion: 1, kind: 'job-chunk', ownerId, visibility: 'private', jobVersionId: version.id,
      chunkId: randomUUID(), embeddingVersion: spec.embeddingVersion, indexVersion: spec.indexVersion, contentHash: version.document.textHash,
      requirementsHash: 'b'.repeat(64), chunkHash: 'c'.repeat(64) }) }));
  const vector = { query: () => Promise.resolve(points) }, identity = { getOwnerId: () => Promise.resolve(ownerId) };
  const query = { schemaVersion: 1, corpusVersion: 'corpus-v1', skills: ['TS'], summary: '合成技能' };
  const config = { version: 'hybrid-rrf-v1', vectorFailure: 'keyword' };
  return { spec, versions, candidates, keyword, indexes, vector, identity, embedding, query, config, points };
}

await test('S2.3 recall aggregates chunks and only returns current database-visible versions', async () => {
  const f = fixture();
  const service = new RecallService(f.identity, f.keyword, f.indexes, f.embedding, f.vector);
  const result = await service.recall(f.query, f.config, f.spec);
  assert.equal(result.degraded, false); assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates.find(row => row.jobVersionId === f.versions[1]!.id)!.sources.find(source => source.source === 'vector')!.rank, 1);
  assert.equal(result.candidates.filter(row => row.sources.some(source => source.source === 'vector')).length, 2);
  // Concurrent deletion during external work removes the keyword candidate too.
  f.indexes.validCandidates = () => Promise.resolve([f.candidates[2]!]);
  assert.deepEqual((await service.recall(f.query, f.config, f.spec)).candidates.map(row => row.jobVersionId), [f.versions[2]!.id]);
  assert.equal('similarity' in result.candidates[0]!, false);
});

await test('S2.3 index-not-ready and vector failure follow explicit keyword fallback or error policy', async () => {
  const f = fixture(); let calls = 0;
  f.vector.query = () => { calls++; return Promise.reject(new TaskFailure('UPSTREAM_TIMEOUT')); };
  const service = new RecallService(f.identity, f.keyword, f.indexes, f.embedding, f.vector);
  const degraded = await service.recall(f.query, f.config, f.spec);
  assert.equal(degraded.degradationReason, 'VECTOR_UNAVAILABLE'); assert.ok(degraded.candidates.every(row => row.sources.every(source => source.source === 'keyword')));
  await assert.rejects(service.recall(f.query, { ...f.config, vectorFailure: 'error' }, f.spec), /VECTOR_UNAVAILABLE/);
  f.indexes.assertCorpusReady = () => Promise.reject(new Error('INDEX_NOT_READY'));
  calls = 0;
  assert.equal((await service.recall(f.query, f.config, f.spec)).degradationReason, 'INDEX_NOT_READY'); assert.equal(calls, 0);
  await assert.rejects(service.recall(f.query, { ...f.config, vectorFailure: 'error' }, f.spec), /INDEX_NOT_READY/);
  assert.equal((await service.recall({ ...f.query, summary: '' }, f.config, f.spec)).degradationReason, 'EMPTY_VECTOR_QUERY');
});

await test('S2.3 recall never downgrades database, reservation, budget, cancellation or configuration failures', async () => {
  const f = fixture(), service = new RecallService(f.identity, f.keyword, f.indexes, f.embedding, f.vector);
  await assert.rejects(service.recall(f.query, f.config, { ...f.spec, ownerId: randomUUID() }), /CONFIGURATION_MISMATCH/);
  await assert.rejects(service.recall(f.query, f.config, f.spec, { reserve: () => Promise.reject(new Error('RESERVATION_FAILED')) }), /RESERVATION_FAILED/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.recall(f.query, f.config, f.spec, { signal: abort.signal }), /CANCELLED/);
  await assert.rejects(service.recall(f.query, f.config, f.spec, { deadline: Date.now() - 1 }), /DEADLINE_EXCEEDED/);
  await assert.rejects(service.recall({ ...f.query, summary: '长'.repeat(2000) }, f.config, f.spec), EmbeddingFailure);
  f.indexes.visibleVersions = () => Promise.reject(new Error('DATABASE_READ_FAILED'));
  await assert.rejects(service.recall(f.query, f.config, f.spec), /DATABASE_READ_FAILED/);
  f.indexes.assertCorpusReady = () => Promise.reject(new Error('DATABASE_READ_FAILED'));
  await assert.rejects(service.recall(f.query, f.config, f.spec), /DATABASE_READ_FAILED/);
});

await test('S2.3 vector results with stale document hashes never enter vector ranks', async () => {
  const f = fixture();
  f.points.forEach(point => { point.payload.contentHash = 'd'.repeat(64); });
  const result = await new RecallService(f.identity, f.keyword, f.indexes, f.embedding, f.vector).recall(f.query, f.config, f.spec);
  assert.equal(result.degraded, false); assert.ok(result.candidates.every(row => row.sources.length === 1 && row.sources[0]!.source === 'keyword'));
});
