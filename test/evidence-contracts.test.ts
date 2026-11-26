import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { evidenceRefSchema, extractedDocumentSchema } from '../src/contracts/evidence.js';
import { resumeListQuerySchema, resumeVersionResponseSchema } from '../src/contracts/resumes.js';

await test('evidence ranges use UTF-16 code units and reject empty/reversed/unknown fields', () => {
  const ref = { sourceType: 'RESUME', sourceVersionId: randomUUID(), blockId: randomUUID(), start: 2, end: 6, quote: '中文😀' };
  assert.deepEqual(evidenceRefSchema.parse(ref), ref);
  for (const patch of [{ end: 5 }, { start: -1 }, { start: 6 }, { quote: '' }, { score: 100 }]) {
    assert.equal(evidenceRefSchema.safeParse({ ...ref, ...patch }).success, false);
  }
});

await test('document identity and response projections reject ambiguous or internal data', () => {
  const id = randomUUID();
  const hash = 'a'.repeat(64);
  const document = { schemaVersion: 1, sourceType: 'RESUME', sourceVersionId: id, fileHash: hash,
    parserVersion: 'synthetic-contract-v1', normalizationVersion: 'text-v1', warnings: [],
    blocks: [{ id: randomUUID(), ordinal: 0, text: '合成文本', textHash: hash,
      location: { kind: 'DOCX', paragraph: 0, table: null } }],
  };
  assert.equal(extractedDocumentSchema.safeParse(document).success, true);
  assert.equal(extractedDocumentSchema.safeParse({ ...document, blocks: [...document.blocks, ...document.blocks] }).success, false);
  assert.equal(extractedDocumentSchema.safeParse({ ...document, blocks: [] }).success, false);
  const response = { resumeId: randomUUID(), resumeVersionId: id, version: 1,
    file: { sha256: hash, mime: 'application/pdf', size: 1 }, extractedDocument: document, createdAt: new Date().toISOString() };
  assert.equal(resumeVersionResponseSchema.safeParse(response).success, true);
  assert.equal(resumeVersionResponseSchema.safeParse({ ...response, ownerId: randomUUID() }).success, false);
  assert.equal(resumeVersionResponseSchema.safeParse({ ...response, resumeVersionId: randomUUID() }).success, false);
  assert.equal(resumeListQuerySchema.safeParse({ limit: '101' }).success, false);
  assert.equal(resumeListQuerySchema.safeParse({ ownerId: randomUUID() }).success, false);
});
