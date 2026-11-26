import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { extractedDocument, validateEvidence, textHash } from '../src/modules/resumes/evidence.js';

await test('evidence quotes bind owner, version, block, exact UTF-16 ranges and immutable normalized text', () => {
  const owner = randomUUID(), version = randomUUID();
  const output = { parserVersion: 'fixture', blocks: [{ text: '中文\r\n😀e\u0301', location: { kind: 'PDF', page: 1, bounds: null } }], warnings: [] };
  const document = extractedDocument(version, 'a'.repeat(64), output), block = document.blocks[0]!;
  assert.equal(block.text, '中文\n😀é');
  assert.deepEqual(extractedDocument(version, 'a'.repeat(64), output), document);
  const ref = { sourceType: 'RESUME', sourceVersionId: version, blockId: block.id, start: 0, end: 6, quote: block.text };
  assert.deepEqual(validateEvidence(owner, owner, document, ref), ref);
  for (const patch of [{ sourceVersionId: randomUUID() }, { blockId: randomUUID() }, { sourceType: 'JD' },
    { start: 3, end: 4, quote: '\ud83d' }, { start: 4, end: 5, quote: '\ude00' }, { end: 7, quote: block.text + 'x' },
    { quote: '伪造\n😀é' }]) assert.throws(() => validateEvidence(owner, owner, document, { ...ref, ...patch }));
  assert.throws(() => validateEvidence(randomUUID(), owner, document, ref));
  assert.equal(block.textHash, textHash(block.text));
});
