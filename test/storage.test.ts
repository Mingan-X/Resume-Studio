import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { stagedFileSchema } from '../src/modules/storage/storage.port.js';
import { z } from 'zod';
import { LocalStorage } from '../src/infrastructure/storage/local-storage.js';

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'resume-storage-'));
  const root = join(parent, 'owned');
  const storage = await LocalStorage.create(root, 64);
  return { parent, root, storage, close: async () => {
    assert.equal(relative(resolve(tmpdir()), resolve(parent)).startsWith('..'), false);
    await rm(parent, { recursive: true });
  } };
}
const input = (text: string) => Readable.from([Buffer.from(text)]);

await test('storage streams exact bytes, uses unique keys, persists and never discards committed files', async () => {
  const f = await fixture();
  try {
    const file = await f.storage.stage(input('中文\r\n😀'));
    const other = await f.storage.stage(input('中文\r\n😀'));
    assert.notEqual(file.storageKey, other.storageKey);
    assert.equal(file.sha256, createHash('sha256').update('中文\r\n😀').digest('hex'));
    await f.storage.commit(file);
    const restarted = await LocalStorage.create(f.root, 64);
    assert.equal((await restarted.read(file.storageKey)).toString(), '中文\r\n😀');
    await assert.rejects(restarted.commit(file));
    await assert.rejects(restarted.discard(file));
    await restarted.discard(other);
    assert.deepEqual(await readdir(join(f.root, 'files')), [file.storageKey]);
  } finally { await f.close(); }
});

await test('limits, input errors and abort compensate only the current temporary operation', async () => {
  const f = await fixture();
  try {
    const retained = await f.storage.stage(input('keep'));
    await assert.rejects(f.storage.stage(input('x'.repeat(65))), /FILE_TOO_LARGE/);
    await assert.rejects(f.storage.stage(input('')), /EMPTY_FILE/);
    const broken = Readable.from((async function* () { yield Buffer.from('one'); throw new Error('write-input-failure'); })());
    await assert.rejects(f.storage.stage(broken), /write-input-failure/);
    const controller = new AbortController();
    const slow = new Readable({ read() { this.push(Buffer.from('x')); controller.abort(); } });
    await assert.rejects(f.storage.stage(slow, controller.signal));
    assert.deepEqual(await readdir(join(f.root, 'staging')), [retained.operationId]);
  } finally { await f.close(); }
});

await test('storage rejects path traversal, absolute keys and junction escape before file access', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'resume-storage-outside-'));
  try {
    for (const key of ['../outside', outside, 'C:\\escape', '/etc/passwd', '..']) await assert.rejects(f.storage.read(key));
    await writeFile(join(outside, 'sentinel'), 'untouched');
    await symlink(outside, join(f.parent, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(LocalStorage.create(join(f.parent, 'linked', 'child')));
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
  } finally { await f.close(); assert.equal(relative(resolve(tmpdir()), resolve(outside)).startsWith('..'), false); await rm(outside, { recursive: true }); }
});

await test('reclaimer checks database references, age and state under an exclusive operation lock', async () => {
  const f = await fixture();
  try {
    const abandoned = await f.storage.stage(input('old'));
    const referenced = await f.storage.stage(input('referenced'));
    const committed = await f.storage.stage(input('committed'));
    await f.storage.commit(committed);
    const before = new Date();
    const result = await f.storage.reclaim(before, { isReferenced: key => Promise.resolve(key === referenced.storageKey) });
    assert.deepEqual(result.removed, [abandoned.operationId]);
    assert.deepEqual(result.retained.sort(), [referenced.operationId, committed.operationId].sort());
    await assert.rejects(f.storage.reclaim(before, { isReferenced: () => Promise.reject(new Error('db-down')) }), /db-down/);
    assert.equal((await f.storage.read(committed.storageKey)).toString(), 'committed');
    assert.equal((await f.storage.inspect(referenced.operationId)).state, 'READY');
  } finally { await f.close(); }
});

await test('failed commit preserves a verifiable state and reclaimer refuses links or unowned roots', async () => {
  const f = await fixture();
  try {
    const file = await f.storage.stage(input('retain-on-failure'));
    await mkdir(join(f.root, 'files', file.storageKey));
    await assert.rejects(f.storage.commit(file));
    assert.equal((await f.storage.inspect(file.operationId)).state, 'READY');
    assert.equal(await readFile(join(f.root, 'staging', file.operationId, 'payload'), 'utf8'), 'retain-on-failure');
    const unowned = join(f.parent, 'unowned');
    await mkdir(unowned); await writeFile(join(unowned, 'sentinel'), 'keep');
    await assert.rejects(LocalStorage.create(unowned));
    await symlink(unowned, join(f.root, 'staging', file.operationId, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.storage.reclaim(new Date(), { isReferenced: () => Promise.resolve(false) }));
    assert.equal(await readFile(join(unowned, 'sentinel'), 'utf8'), 'keep');
  } finally { await f.close(); }
});

await test('reclaimer holds the operation lock across the database check and retains active uploads', async () => {
  const f = await fixture();
  try {
    const file = await f.storage.stage(input('race'));
    const result = await f.storage.reclaim(new Date(), { isReferenced: async () => {
      await assert.rejects(f.storage.commit(file));
      await assert.rejects(f.storage.discard(file));
      return true;
    } });
    assert.deepEqual(result.removed, []);
    await f.storage.commit(file);
    assert.equal((await f.storage.read(file.storageKey)).toString(), 'race');
  } finally { await f.close(); }
});

await test('upload reconciliation only removes expired unreferenced files after the exact uploader process has exited', { timeout: 20_000 }, async () => {
  const f = await fixture();
  const child = fork(new URL('./fixtures/storage-crash.fixture.js', import.meta.url), [], {
    env: { ...process.env, STORAGE_TEST_ROOT: f.root }, silent: true,
  });
  const exited = once(child, 'exit'); child.stdout?.resume(); child.stderr?.resume();
  try {
    const file = stagedFileSchema.parse((await once(child, 'message'))[0]);
    const path = join(f.root, 'staging', file.operationId, 'manifest.json');
    const value = z.record(z.string(), z.json()).parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    await writeFile(path, JSON.stringify({ ...value, createdAt: '2020-01-01T00:00:00.000Z' }));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    assert.equal((await f.storage.reconcileUploads(cutoff, { isReferenced: () => Promise.resolve(false) })).removed.length, 0);
    child.kill('SIGKILL'); await exited;
    assert.equal((await f.storage.reconcileUploads(cutoff, { isReferenced: () => Promise.resolve(true) })).removed.length, 0);
    assert.deepEqual((await f.storage.reconcileUploads(cutoff, { isReferenced: () => Promise.resolve(false) })).removed, [file.operationId]);
    assert.deepEqual(await readdir(join(f.root, 'files')), []);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await f.close(); }
});
