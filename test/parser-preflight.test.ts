import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentType, preflightDocx } from '../src/infrastructure/parsing/preflight.js';
import { parserLimitsSchema } from '../src/modules/parsing/contracts.js';
import { IsolatedParser } from '../src/infrastructure/parsing/isolation.js';
import { minimalDocxEntries, syntheticZip } from './support/document-fixtures.js';

const limits = parserLimitsSchema.parse({});
const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
await test('preflight cross-checks extension/mime/signature and refuses legacy/encrypted containers', () => {
  assert.equal(documentType(Buffer.from('%PDF-1.7'), 'resume.pdf', 'application/pdf', limits), 'PDF');
  assert.equal(documentType(syntheticZip(minimalDocxEntries()), 'resume.docx', mime, limits), 'DOCX');
  for (const name of ['file.doc', 'file.docm', 'file.exe']) assert.throws(() => documentType(Buffer.from('data'), name, mime, limits), /UNSUPPORTED_TYPE/);
  assert.throws(() => documentType(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'encrypted.docx', mime, limits), /ENCRYPTED_FILE/);
  assert.throws(() => documentType(Buffer.from('a'), 'file.docx', mime, limits), /SIGNATURE_MISMATCH/);
  assert.throws(() => documentType(Buffer.from('%PDF-1.7'), 'file.pdf', mime, limits), /SIGNATURE_MISMATCH/);
  assert.throws(() => documentType(Buffer.alloc(11), 'file.pdf', 'application/pdf', { ...limits, maxBytes: 10 }), /FILE_TOO_LARGE/);
});
await test('ZIP validation checks actual expansion, CRC, package structure and dangerous entries', async () => {
  await preflightDocx(syntheticZip(minimalDocxEntries()), limits);
  for (const name of ['../escape', '/absolute', 'C:/escape', 'nested.zip']) {
    await assert.rejects(preflightDocx(syntheticZip([...minimalDocxEntries(), { name, text: 'bad' }]), limits));
  }
  for (const entry of [
    { name: 'link', text: 'outside', mode: 0xa1ff },
    { name: 'bad.xml', text: '<!DOCTYPE x [<!ENTITY y "bad">]><x>&y;</x>' },
    { name: 'bad.rels', text: '<Relationship TargetMode="External" Target="file:///outside"/>' },
    { name: 'bad.xml', text: 'hello', crc: 0 },
    { name: 'bad.xml', text: 'actual-data', claimedSize: 1 },
    { name: 'nested.bin', text: Buffer.from('504b030400000000', 'hex') },
  ]) await assert.rejects(preflightDocx(syntheticZip([...minimalDocxEntries(), entry]), limits));
  await assert.rejects(preflightDocx(syntheticZip(minimalDocxEntries().slice(0, 2)), limits));
  await assert.rejects(preflightDocx(syntheticZip(minimalDocxEntries()), { ...limits, maxEntries: 2 }), /ZIP_LIMIT/);
  await assert.rejects(preflightDocx(syntheticZip(minimalDocxEntries()), { ...limits, maxExpandedBytes: 100 }), /ZIP_LIMIT/);
  await assert.rejects(preflightDocx(syntheticZip([...minimalDocxEntries(), { name: 'bomb', text: 'a'.repeat(100_000) }]), limits), /ZIP_LIMIT/);
});
await test('isolated parser blocks network/files/secrets, validates output and confirms killed children exit', { timeout: 60_000 }, async () => {
  const entry = new URL('./fixtures/parser-worker.fixture.js', import.meta.url);
  const parser = new IsolatedParser({}, entry);
  assert.equal((await parser.parse(Buffer.from('synthetic'), 'ok', mime)).blocks[0]?.text, '中文😀');
  await assert.rejects(parser.parse(Buffer.from('synthetic'), 'invalid', mime), /CORRUPT_FILE/);
  await assert.rejects(new IsolatedParser({ maxText: 10 }, entry).parse(Buffer.from('synthetic'), 'long', mime), /TEXT_LIMIT/);
  let pid = 0;
  const timeout = new IsolatedParser({ timeoutMs: 1000 }, entry, value => { pid = value; });
  await assert.rejects(timeout.parse(Buffer.from('synthetic'), 'loop', mime), /PARSER_TIMEOUT/);
  assert.throws(() => process.kill(pid, 0));
  const aborted = new AbortController();
  const waiting = parser.parse(Buffer.from('synthetic'), 'loop', mime, aborted.signal);
  await assert.rejects(parser.parse(Buffer.from('synthetic'), 'ok', mime), /PARSER_BUSY/);
  aborted.abort(); await assert.rejects(waiting, /PARSER_ABORTED/);
  const memory = new IsolatedParser({ rssMiB: 32 }, entry, value => { pid = value; });
  await assert.rejects(memory.parse(Buffer.from('synthetic'), 'memory', mime), /PARSER_MEMORY_LIMIT/);
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(new IsolatedParser({ heapMiB: 16 }, entry).parse(Buffer.from('synthetic'), 'heap', mime), /PARSER_MEMORY_LIMIT/);
});
