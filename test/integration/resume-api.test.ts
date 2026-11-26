import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../../src/app-api.module.js';
import { configureHttp } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { ResumeApiModule } from '../../src/modules/resumes/resume-api.module.js';
import { IDENTITY } from '../../src/modules/identity/identity.module.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { ResumeRepository } from '../../src/infrastructure/storage/resume.repository.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { resumeListResponseSchema, resumeVersionResponseSchema } from '../../src/contracts/resumes.js';
import { syntheticPdf, minimalDocxEntries, syntheticZip } from '../support/document-fixtures.js';
import { RESUME_PARSER, RESUME_STORAGE } from '../../src/modules/resumes/resume.service.js';
import type { ParserPort } from '../../src/modules/parsing/contracts.js';
import type { StoragePort } from '../../src/modules/storage/storage.port.js';

await test('S2.1 real upload HTTP, files and database preserve idempotency, pagination, ownership and failure compensation', { timeout: 120_000 }, async t => {
  await ownedPostgres();
  const ownerId = randomUUID(), otherOwner = randomUUID(), root = await mkdtemp(join(tmpdir(), 'resume-http-'));
  let activeOwner = ownerId;
  const config = loadInfrastructureConfig(process.env);
  const module = await Test.createTestingModule({ imports: [ApiModule.register(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000' }), [
    ResumeApiModule.register({ databaseUrl: config.databaseUrl, storageRoot: root }),
  ])] }).overrideProvider(IDENTITY).useValue({ getOwnerId: () => Promise.resolve(activeOwner) }).compile();
  const app = module.createNestApplication({ logger: false }); configureHttp(app);
  const database = module.get(DatabaseService), db = database.client;
  const repository = module.get(ResumeRepository), storage = module.get<StoragePort>(RESUME_STORAGE), parser = module.get<ParserPort>(RESUME_PARSER);
  await db.owner.createMany({ data: [{ id: ownerId }, { id: otherOwner }] });
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const id of [ownerId, otherOwner]) await db.$transaction(async tx => {
        await tx.resumeUpload.deleteMany({ where: { ownerId: id } }); await tx.extractedDocument.deleteMany({ where: { ownerId: id } });
        await tx.evidenceBlock.deleteMany({ where: { ownerId: id } }); await tx.resumeVersion.deleteMany({ where: { ownerId: id } });
        await tx.resume.deleteMany({ where: { ownerId: id } }); await tx.fileAsset.deleteMany({ where: { ownerId: id } }); await tx.owner.delete({ where: { id } });
      });
    } finally { await app.close(); assert.equal(relative(resolve(tmpdir()), resolve(root)).startsWith('..'), false); await rm(root, { recursive: true }); }
  });
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const upload = (bytes: Buffer, key = randomUUID(), filename = 'resume.pdf', mime = 'application/pdf') => {
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    return fetch(`${base}/api/v1/resumes`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: form });
  };
  const bytes = syntheticPdf([{ text: '合成简历' }]), key = randomUUID();
  const first = await upload(bytes, key); assert.equal(first.status, 201);
  const saved = resumeVersionResponseSchema.parse(await first.json());
  await t.test('same-key replay persists one version; conflicts are 409 and responses hide internal data', async () => {
    const replay = await upload(bytes, key); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), saved);
    const conflict = await upload(syntheticPdf([{ text: '不同内容' }]), key); assert.equal(conflict.status, 409); await conflict.body?.cancel();
    assert.equal(await db.resume.count({ where: { ownerId } }), 1);
    assert.equal((await readdir(join(root, 'files'))).length, 1);
    assert.equal((await readdir(join(root, 'staging'))).length, 1);
    const serialized = JSON.stringify(saved);
    for (const privateName of ['storageKey', 'ownerId', root, 'DATABASE_URL']) assert.ok(!serialized.includes(privateName));
    const reopened = new DatabaseService(config);
    try { assert.deepEqual(await new ResumeRepository(reopened).document(ownerId, saved.resumeVersionId), saved.extractedDocument); }
    finally { await reopened.onModuleDestroy(); }
  });
  await t.test('list cursors and details are owner scoped; second document is genuine DOCX', async () => {
    const second = await upload(syntheticZip(minimalDocxEntries()), randomUUID(), 'resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(second.status, 201); await second.body?.cancel();
    const page = resumeListResponseSchema.parse(await (await fetch(`${base}/api/v1/resumes?limit=1`)).json());
    assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
    const next = resumeListResponseSchema.parse(await (await fetch(`${base}/api/v1/resumes?limit=1&cursor=${page.nextCursor}`)).json());
    assert.equal(next.items.length, 1); assert.notEqual(next.items[0]?.id, page.items[0]?.id); assert.equal(next.nextCursor, null);
    const path = `${base}/api/v1/resumes/${saved.resumeId}/versions/${saved.resumeVersionId}`;
    assert.deepEqual(await (await fetch(path)).json(), saved);
    activeOwner = otherOwner;
    assert.equal((await fetch(path)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/v1/resumes`)).json(), { items: [], nextCursor: null });
    activeOwner = ownerId;
    assert.equal((await fetch(`${base}/api/v1/resumes?ownerId=${otherOwner}`)).status, 400);
  });
  await t.test('invalid/empty/scanned/encrypted/oversize requests leave no business records or temporary files', async () => {
    const before = await db.resume.count({ where: { ownerId } }), files = await readdir(join(root, 'files')), staging = await readdir(join(root, 'staging'));
    for (const [input, status] of [[Buffer.from('bad'), 422], [Buffer.alloc(0), 422], [syntheticPdf([{ image: true }]), 422],
      [syntheticPdf([{}]), 422], [syntheticPdf([{ text: 'secret' }], true), 422], [Buffer.alloc(10 * 1024 * 1024 + 1), 413]] as const) {
      const response = await upload(input); assert.equal(response.status, status); const error = await response.json(); assert.ok(JSON.stringify(error).includes('reason'));
    }
    assert.equal(await db.resume.count({ where: { ownerId } }), before);
    assert.deepEqual(await readdir(join(root, 'files')), files); assert.deepEqual(await readdir(join(root, 'staging')), staging);
  });
  await t.test('file commit and database failure compensate exact files; aborted parse creates no records', async () => {
    const files = await readdir(join(root, 'files')), staging = await readdir(join(root, 'staging')), count = await db.resume.count({ where: { ownerId } });
    const commit = storage.commit.bind(storage);
    storage.commit = () => Promise.reject(new Error('synthetic file failure'));
    try { const response = await upload(bytes); assert.equal(response.status, 500); await response.body?.cancel(); } finally { storage.commit = commit; }
    const register = repository.register.bind(repository);
    repository.register = () => Promise.reject(new Error('synthetic database failure'));
    try { const response = await upload(bytes); assert.equal(response.status, 500); await response.body?.cancel(); } finally { repository.register = register; }
    const parse = parser.parse.bind(parser), abort = new AbortController();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let ended!: () => void; const stopped = new Promise<void>(resolve => { ended = resolve; });
    parser.parse = async (_bytes, _filename, _mime, signal) => {
      entered(); await new Promise<void>(resolve => { signal?.addEventListener('abort', () => resolve(), { once: true }); });
      ended(); throw new Error('aborted');
    };
    try {
      const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'a.pdf');
      const pending = fetch(`${base}/api/v1/resumes`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: form, signal: abort.signal });
      await started; abort.abort(); await assert.rejects(pending); await stopped;
      // Wait for the server's compensation to finish, bounded by the same request budget.
      const deadline = Date.now() + 5000;
      while ((await readdir(join(root, 'staging'))).length !== staging.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    } finally { parser.parse = parse; }
    assert.equal(await db.resume.count({ where: { ownerId } }), count);
    assert.deepEqual(await readdir(join(root, 'files')), files); assert.deepEqual(await readdir(join(root, 'staging')), staging);
  });
  await t.test('lost database commit response preserves referenced file and same key recovers the committed version', async () => {
    const register = repository.register.bind(repository), key = randomUUID(), before = await db.resume.count({ where: { ownerId } });
    repository.register = async (...args) => { await register(...args); throw new Error('synthetic lost commit response'); };
    try { const response = await upload(bytes, key); assert.equal(response.status, 500); await response.body?.cancel(); } finally { repository.register = register; }
    assert.equal(await db.resume.count({ where: { ownerId } }), before + 1);
    const recovered = await upload(bytes, key); assert.equal(recovered.status, 201);
    const version = resumeVersionResponseSchema.parse(await recovered.json());
    const row = await repository.findVersion(ownerId, version.resumeVersionId); assert.ok(row);
    assert.deepEqual(await storage.read(row.fileAsset.storageKey), bytes);
    assert.equal(await db.resume.count({ where: { ownerId } }), before + 1);
  });
});
