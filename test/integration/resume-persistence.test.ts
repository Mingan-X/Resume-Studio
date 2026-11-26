import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { LocalStorage } from '../../src/infrastructure/storage/local-storage.js';
import { IsolatedParser } from '../../src/infrastructure/parsing/isolation.js';
import { extractedDocument } from '../../src/modules/resumes/evidence.js';
import { syntheticPdf, syntheticZip, minimalDocxEntries } from '../support/document-fixtures.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ResumeRepository, type registerResumeSchema } from '../../src/infrastructure/storage/resume.repository.js';
import { IdempotencyConflictError } from '../../src/modules/tasks/task-errors.js';

await test('S2.1 real database preserves resume identity, owner constraints, immutable content and atomic upload', { timeout: 90_000 }, async t => {
  await ownedPostgres();
  const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client;
  const repository = new ResumeRepository(database);
  const owners: string[] = [];
  const taskCount = await db.analysisTask.count();
  t.after(async () => {
    try {
      await ownedPostgres();
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.resumeUpload.deleteMany({ where: { ownerId } });
          await tx.extractedDocument.deleteMany({ where: { ownerId } });
          await tx.evidenceBlock.deleteMany({ where: { ownerId } });
          await tx.resumeVersion.deleteMany({ where: { ownerId } });
          await tx.resume.deleteMany({ where: { ownerId } });
          await tx.fileAsset.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        assert.equal(await db.fileAsset.count({ where: { ownerId } }), 0);
      }
      assert.equal(await db.analysisTask.count(), taskCount);
    } finally { await database.onModuleDestroy(); }
  });
  for (const id of [randomUUID(), randomUUID()]) { await db.owner.create({ data: { id } }); owners.push(id); }
  const ownerId = owners[0]!, otherOwner = owners[1]!;
  const sample = (owner = ownerId): z.infer<typeof registerResumeSchema> => ({ ownerId: owner, idempotencyKey: randomUUID(),
    resumeId: randomUUID(), resumeVersionId: randomUUID(),
    file: { id: randomUUID(), ownerId: owner, storageKey: randomUUID(), sha256: 'a'.repeat(64),
      mime: 'application/pdf', size: 10, createdAt: new Date().toISOString() },
    blocks: [{ id: randomUUID(), ordinal: 0, text: '合成中文\n项目😀',
      textHash: createHash('sha256').update('合成中文\n项目😀').digest('hex'), location: { kind: 'PDF', page: 1, bounds: null } }],
  });
  const input = sample();
  await t.test('same owner/key/hash converges; conflicting hash is rejected and owners stay isolated', async () => {
    const results = await Promise.all([repository.register(input), repository.register(input)]);
    assert.equal(results.filter(result => result.replay).length, 1);
    assert.ok(results.every(result => result.resumeVersionId === input.resumeVersionId));
    await assert.rejects(repository.register({ ...input, file: { ...input.file, sha256: 'b'.repeat(64) } }), IdempotencyConflictError);
    assert.equal(await repository.findVersion(otherOwner, input.resumeVersionId), null);
    assert.equal((await repository.findVersion(ownerId, input.resumeVersionId))?.blocks[0]?.text, input.blocks[0]?.text);
    assert.equal(await repository.isReferenced(input.file.storageKey), true);
    await assert.rejects(repository.register({ ...input, ownerId: otherOwner }));
  });
  await t.test('database independently rejects cross-owner relations, duplicate versions and updates', async () => {
    const foreign = sample(otherOwner); await repository.register(foreign);
    await assert.rejects(db.resumeVersion.create({ data: { id: randomUUID(), ownerId,
      resumeId: input.resumeId, version: 2, fileAssetId: foreign.file.id, fileHash: foreign.file.sha256 } }));
    await assert.rejects(db.resumeVersion.create({ data: { id: randomUUID(), ownerId,
      resumeId: input.resumeId, version: 1, fileAssetId: input.file.id, fileHash: input.file.sha256 } }));
    await assert.rejects(db.fileAsset.update({ where: { id: input.file.id }, data: { sha256: 'c'.repeat(64) } }));
    await assert.rejects(db.evidenceBlock.update({ where: { id: input.blocks[0]!.id }, data: { text: 'changed' } }));
    await assert.rejects(db.resumeVersion.update({ where: { id: input.resumeVersionId }, data: { version: 2 } }));
  });
  await t.test('late block insertion failure rolls back file, resume, version and idempotency records', async () => {
    const failing = sample(); failing.blocks[0]!.id = input.blocks[0]!.id;
    await assert.rejects(repository.register(failing));
    assert.equal(await db.fileAsset.count({ where: { id: failing.file.id } }), 0);
    assert.equal(await db.resume.count({ where: { id: failing.resumeId } }), 0);
    assert.equal(await db.resumeVersion.count({ where: { id: failing.resumeVersionId } }), 0);
    assert.equal(await db.resumeUpload.count({ where: { ownerId, idempotencyKey: failing.idempotencyKey } }), 0);
    const reopened = new DatabaseService(loadInfrastructureConfig(process.env));
    try { assert.ok(await new ResumeRepository(reopened).findVersion(ownerId, input.resumeVersionId)); }
    finally { await reopened.onModuleDestroy(); }
  });
  await t.test('T2 reclaim command checks actual FileAsset references and deletes only expired temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resume-reclaim-db-'));
    try {
      const storage = await LocalStorage.create(root);
      const staged = await storage.stage(Readable.from([Buffer.from('synthetic file')]));
      const abandoned = await storage.stage(Readable.from([Buffer.from('abandoned')]));
      const value = sample();
      value.file.storageKey = staged.storageKey; value.file.sha256 = staged.sha256; value.file.size = staged.size;
      await repository.register(value);
      for (const file of [staged, abandoned]) {
        const path = join(root, 'staging', file.operationId, 'manifest.json');
        const manifest = z.record(z.string(), z.json()).parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
        await writeFile(path, JSON.stringify({ ...manifest, createdAt: '2020-01-01T00:00:00.000Z' }));
      }
      const result = await promisify(execFile)(process.execPath, ['dist/src/infrastructure/storage/cli.js'], {
        env: { ...process.env, STORAGE_ROOT: root }, timeout: 45_000,
      });
      assert.deepEqual(JSON.parse(result.stdout), { code: 'STORAGE_RECLAIMED', removed: 1, retained: 1 });
      assert.deepEqual(await readdir(join(root, 'staging')), [staged.operationId]);
    } finally {
      // Exact directory created by this subtest, never a configured storage root.
      assert.equal(relative(resolve(tmpdir()), resolve(root)).startsWith('..'), false);
      await rm(root, { recursive: true });
    }
  });
  await t.test('T7 real PDF/DOCX file and database artifacts stay separate across concurrent owners and validate exact references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resume-evidence-db-'));
    try {
      const storage = await LocalStorage.create(root);
      const results = await Promise.all([
        { owner: ownerId, bytes: syntheticPdf([{ text: '甲项目😀' }]), name: 'a.pdf', mime: 'application/pdf' },
        { owner: otherOwner, bytes: syntheticZip(minimalDocxEntries()), name: 'b.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ].map(async source => {
        const file = await storage.stage(Readable.from([source.bytes]));
        const parsed = await new IsolatedParser().parse(source.bytes, source.name, source.mime);
        const value = sample(source.owner), document = extractedDocument(value.resumeVersionId, file.sha256, parsed);
        value.file = { ...value.file, storageKey: file.storageKey, sha256: file.sha256, size: file.size,
          mime: source.mime === 'application/pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
        value.blocks = document.blocks; value.document = document;
        await storage.commit(file); await repository.register(value);
        assert.deepEqual(await storage.read(file.storageKey), source.bytes);
        assert.deepEqual(await repository.document(source.owner, value.resumeVersionId), document);
        const block = document.blocks[0]!;
        const ref = { sourceType: 'RESUME', sourceVersionId: value.resumeVersionId, blockId: block.id, start: 0, end: block.text.length, quote: block.text };
        assert.deepEqual(await repository.validateReference(source.owner, value.resumeVersionId, ref), ref);
        await assert.rejects(repository.validateReference(source.owner, value.resumeVersionId, { ...ref, quote: '伪造引用' }));
        await assert.rejects(db.extractedDocument.update({ where: { sourceVersionId: value.resumeVersionId }, data: { document: {} } }));
        await assert.rejects(db.evidenceBlock.create({ data: { ...block, id: randomUUID(), ordinal: 999,
          ownerId: source.owner, sourceVersionId: value.resumeVersionId } }));
        return { source, value, ref };
      }));
      const [first, second] = results;
      assert.ok(first && second);
      assert.equal(await repository.document(first.source.owner, second.value.resumeVersionId), null);
      await assert.rejects(repository.validateReference(first.source.owner, first.value.resumeVersionId, second.ref));
    } finally { assert.equal(relative(resolve(tmpdir()), resolve(root)).startsWith('..'), false); await rm(root, { recursive: true }); }
  });
});
