import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedParser } from '../src/infrastructure/parsing/isolation.js';
import { syntheticPdf } from './support/document-fixtures.js';

await test('PDF parser extracts synthetic Chinese/multiple pages and exposes page-only evidence with honest layout warnings', { timeout: 60_000 }, async () => {
  const parser = new IsolatedParser();
  const result = await parser.parse(syntheticPdf([{ text: '中文项目' }, { text: '技能列表' }]), 'resume.pdf', 'application/pdf');
  assert.deepEqual(result.blocks.map(block => block.text), ['中文项目', '技能列表']);
  assert.deepEqual(result.blocks.map(block => block.location), [{ kind: 'PDF', page: 1, bounds: null }, { kind: 'PDF', page: 2, bounds: null }]);
  assert.match(result.parserVersion, /6\.5\.438/);
  const columns = await parser.parse(syntheticPdf([{ text: '左栏', columns: true }]), 'columns.pdf', 'application/pdf');
  assert.deepEqual(columns.blocks.map(block => block.text), ['左栏', '左栏']);
  assert.ok(columns.warnings.includes('READING_ORDER_UNCERTAIN'));
  const mixed = await parser.parse(syntheticPdf([{ text: '文字页' }, { image: true }]), 'mixed.pdf', 'application/pdf');
  assert.ok(mixed.warnings.includes('PARTIAL_TEXT_LAYER'));
  const list = await parser.parse(syntheticPdf([{ text: '项目列表', rows: ['项目甲', '项目乙'] }]), 'projects.pdf', 'application/pdf');
  assert.deepEqual(list.blocks.map(block => block.text), ['项目列表', '项目甲', '项目乙']);
  const boundary = await parser.parse(syntheticPdf(Array.from({ length: 30 }, () => ({ text: '页' }))), 'boundary.pdf', 'application/pdf');
  assert.equal(boundary.blocks.length, 30);
});
await test('PDF parser rejects encrypted, scanned, damaged, empty, excess pages and excess text explicitly', { timeout: 60_000 }, async () => {
  const parser = new IsolatedParser();
  for (const [bytes, reason] of [
    [syntheticPdf([{ image: true }]), 'SCANNED_PDF'], [syntheticPdf([{}]), 'EMPTY_TEXT'],
    [syntheticPdf([{ text: 'secret' }], true), 'ENCRYPTED_FILE'], [Buffer.from('%PDF-1.7\nbroken'), 'CORRUPT_FILE'],
    [syntheticPdf(Array.from({ length: 31 }, () => ({ text: '页' }))), 'PAGE_LIMIT'],
  ] as const) await assert.rejects(parser.parse(bytes, 'resume.pdf', 'application/pdf'), new RegExp(reason));
  await assert.rejects(new IsolatedParser({ maxText: 2 }).parse(syntheticPdf([{ text: '超过文本' }]), 'resume.pdf', 'application/pdf'), /TEXT_LIMIT/);
});
