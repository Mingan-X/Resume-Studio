import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedParser } from '../src/infrastructure/parsing/isolation.js';
import { minimalDocxEntries, syntheticZip } from './support/document-fixtures.js';
const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function document(body: string) {
  const entries = minimalDocxEntries();
  entries[2]!.text = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return syntheticZip(entries);
}
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
await test('DOCX preserves Chinese paragraphs, line breaks and row/cell origins without invented page numbers', { timeout: 30_000 }, async () => {
  const body = paragraph('中文简历') + '<w:p><w:r><w:t>项目甲</w:t><w:br/><w:t>后端</w:t></w:r></w:p>'
    + `<w:tbl><w:tr><w:tc>${paragraph('技能')}</w:tc><w:tc>${paragraph('TypeScript')}</w:tc></w:tr><w:tr><w:tc>${paragraph('职责')}</w:tc><w:tc>${paragraph('测试')}</w:tc></w:tr></w:tbl>`;
  const result = await new IsolatedParser().parse(document(body), 'resume.docx', mime);
  assert.deepEqual(result.blocks.map(block => block.text), ['中文简历', '项目甲\n后端', '技能', 'TypeScript', '职责', '测试']);
  assert.deepEqual(result.blocks[2]?.location, { kind: 'DOCX', paragraph: 2, table: { index: 0, row: 0, cell: 0 } });
  assert.deepEqual(result.blocks[5]?.location, { kind: 'DOCX', paragraph: 5, table: { index: 0, row: 1, cell: 1 } });
  assert.ok(result.blocks.every(block => !('page' in block.location)));
});
await test('DOCX rejects empty/missing/corrupt/encrypted and text-limit cases with explicit reasons', { timeout: 30_000 }, async () => {
  const parser = new IsolatedParser();
  await assert.rejects(parser.parse(document(''), 'resume.docx', mime), /EMPTY_TEXT/);
  await assert.rejects(parser.parse(syntheticZip(minimalDocxEntries().slice(0, 2)), 'resume.docx', mime), /CORRUPT_FILE/);
  await assert.rejects(parser.parse(Buffer.from('504b03040000', 'hex'), 'resume.docx', mime), /CORRUPT_FILE/);
  await assert.rejects(parser.parse(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'resume.docx', mime), /ENCRYPTED_FILE/);
  await assert.rejects(parser.parse(document(paragraph('text')), 'resume.doc', mime), /UNSUPPORTED_TYPE/);
  await assert.rejects(new IsolatedParser({ maxText: 2 }).parse(document(paragraph('文本超量')), 'resume.docx', mime), /TEXT_LIMIT/);
});
