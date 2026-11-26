import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { StorageError, stagedFileSchema } from '../../modules/storage/storage.port.js';
import type { StagedFile, StoragePort, StorageReferencePort } from '../../modules/storage/storage.port.js';

const uuid = z.uuid();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), operationId: uuid, storageKey: uuid,
  createdAt: z.iso.datetime(), state: z.enum(['WRITING', 'READY', 'COMMITTING', 'COMMITTED']),
  size: z.int().nonnegative(), sha256: z.string(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

// A private, dedicated root is required; no other principals may mutate it.
// lstat/realpath checks detect existing links, not a hostile local administrator.
export class LocalStorage implements StoragePort {
  private constructor(readonly root: string, private readonly maxBytes: number) {}

  static async create(root: string, maxBytes = 10 * 1024 * 1024): Promise<LocalStorage> {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new StorageError('INVALID_PATH');
    const resolved = resolve(root);
    await this.checkAncestors(dirname(resolved));
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const storage = new LocalStorage(resolved, maxBytes);
    await storage.checked(resolved, true);
    const entries = await readdir(resolved);
    const marker = join(resolved, 'storage-owner.json');
    if (entries.length === 0) {
      const handle = await open(marker, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ project: 'resume-studio', schemaVersion: 1, root: resolved })); await handle.sync(); }
      finally { await handle.close(); }
    } else {
      await storage.checked(marker, false);
      z.object({ project: z.literal('resume-studio'), schemaVersion: z.literal(1), root: z.literal(resolved) })
        .strict().parse(JSON.parse(await readFile(marker, 'utf8')) as unknown);
    }
    for (const name of ['staging', 'files']) {
      await mkdir(join(resolved, name), { recursive: true, mode: 0o700 });
      await storage.checked(join(resolved, name), true);
    }
    return storage;
  }

  private static async checkAncestors(path: string): Promise<void> {
    let current = resolve(path);
    while (true) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new StorageError('INVALID_PATH'); }
      catch (error) { if (!missing(error)) throw error; }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private async checked(path: string, directory: boolean): Promise<string> {
    const resolved = resolve(path), rel = relative(this.root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new StorageError('INVALID_PATH');
    await LocalStorage.checkAncestors(resolved);
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
      || (!directory && info.nlink !== 1)) throw new StorageError('INVALID_PATH');
    const actual = await realpath(resolved);
    if (relative(this.root, actual).startsWith('..') || isAbsolute(relative(this.root, actual))) throw new StorageError('INVALID_PATH');
    return resolved;
  }

  private async operation(id: string): Promise<string> {
    if (!uuid.safeParse(id).success) throw new StorageError('INVALID_PATH');
    await this.checked(join(this.root, 'staging'), true);
    return this.checked(join(this.root, 'staging', id), true);
  }

  private async manifest(id: string): Promise<Manifest> {
    const path = await this.operation(id);
    const file = await this.checked(join(path, 'manifest.json'), false);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > 4096) throw new StorageError('INVALID_STATE');
      const value = manifestSchema.parse(JSON.parse(await handle.readFile('utf8')) as unknown);
      if (value.operationId !== id) throw new StorageError('INVALID_STATE');
      return value;
    } finally { await handle.close(); }
  }

  private async save(value: Manifest): Promise<void> {
    const path = await this.operation(value.operationId);
    const temporary = join(path, `${randomUUID()}.json.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(manifestSchema.parse(value))); await handle.sync(); }
    finally { await handle.close(); }
    // Only this operation's manifest is replaced; payloads are never overwritten.
    await rename(temporary, join(path, 'manifest.json'));
  }

  async stage(input: Readable, signal?: AbortSignal): Promise<StagedFile> {
    signal?.throwIfAborted();
    await this.checked(join(this.root, 'staging'), true);
    const operationId = randomUUID(), storageKey = randomUUID();
    const path = join(this.root, 'staging', operationId);
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, 'lock'), { mode: 0o700 });
    const value: Manifest = { schemaVersion: 1, operationId, storageKey,
      createdAt: new Date().toISOString(), state: 'WRITING', size: 0, sha256: '' };
    let handle: FileHandle | undefined;
    const abort = () => input.destroy(new Error('UPLOAD_ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.save(value);
      handle = await open(join(path, 'payload'), 'wx', 0o600);
      const hash = createHash('sha256');
      for await (const chunk of input) {
        signal?.throwIfAborted();
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new StorageError('STORAGE_IO');
        value.size += chunk.length;
        if (value.size > this.maxBytes) throw new StorageError('FILE_TOO_LARGE');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten === 0) throw new StorageError('STORAGE_IO');
          offset += result.bytesWritten;
        }
      }
      signal?.throwIfAborted();
      if (!value.size) throw new StorageError('EMPTY_FILE');
      await handle.sync(); await handle.close(); handle = undefined;
      value.sha256 = hash.digest('hex'); value.state = 'READY'; await this.save(value);
      return stagedFileSchema.parse({ operationId, storageKey, sha256: value.sha256, size: value.size });
    } catch (error) {
      await handle?.close();
      // An I/O error during cleanup leaves the exact operation manifest for inspection.
      await rmdir(join(path, 'lock')).catch(() => undefined);
      await this.removeStaging(operationId).catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await rmdir(join(path, 'lock')).catch(error => { if (!missing(error)) throw error; });
    }
  }

  private matches(value: Manifest, file: StagedFile): void {
    if (value.storageKey !== file.storageKey || value.sha256 !== file.sha256 || value.size !== file.size) {
      throw new StorageError('INVALID_STATE');
    }
  }

  async commit(input: StagedFile): Promise<void> {
    const file = stagedFileSchema.parse(input);
    const release = await this.lock(file.operationId);
    try {
    const value = await this.manifest(file.operationId);
    this.matches(value, file);
    if (value.state !== 'READY') throw new StorageError('INVALID_STATE');
    const path = await this.operation(file.operationId);
    const source = await this.checked(join(path, 'payload'), false);
    await this.checked(join(this.root, 'files'), true);
    // Reserve the server-generated key exclusively; directory rename cannot replace an existing file.
    const destination = join(this.root, 'files', file.storageKey);
    await mkdir(destination, { mode: 0o700 });
    value.state = 'COMMITTING'; await this.save(value);
    await rename(source, join(destination, 'payload'));
    value.state = 'COMMITTED'; await this.save(value);
    } finally { await release(); }
  }

  async read(key: string): Promise<Buffer> {
    if (!uuid.safeParse(key).success) throw new StorageError('INVALID_PATH');
    await this.checked(join(this.root, 'files'), true);
    await this.checked(join(this.root, 'files', key), true);
    const handle = await open(await this.checked(join(this.root, 'files', key, 'payload'), false), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > this.maxBytes) throw new StorageError('FILE_TOO_LARGE');
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  async discard(input: StagedFile): Promise<void> {
    const file = stagedFileSchema.parse(input);
    const release = await this.lock(file.operationId);
    try {
    const value = await this.manifest(file.operationId);
    this.matches(value, file);
    if (value.state !== 'READY') throw new StorageError('INVALID_STATE');
    await this.removeStaging(file.operationId, true);
    } finally { await release(); }
    await rmdir(await this.operation(file.operationId));
  }

  async inspect(operationId: string): Promise<Manifest> { return this.manifest(operationId); }

  private async lock(id: string): Promise<() => Promise<void>> {
    const path = join(await this.operation(id), 'lock');
    await mkdir(path, { mode: 0o700 });
    return async () => { await rmdir(await this.checked(path, true)); };
  }

  private async removeStaging(id: string, locked = false): Promise<void> {
    const path = await this.operation(id);
    const names = (await readdir(path)).filter(name => !(locked && name === 'lock'));
    // Preflight the entire operation before any unlink; never recurse into unknown directories.
    for (const name of names) {
      if (name !== 'payload' && name !== 'manifest.json' && !/^[a-f0-9-]{36}\.json\.tmp$/.test(name)) throw new StorageError('INVALID_PATH');
      await this.checked(join(path, name), false);
    }
    for (const name of names) await unlink(await this.checked(join(path, name), false));
    if (!locked) await rmdir(await this.operation(id));
  }

  async reclaim(before: Date, references: StorageReferencePort): Promise<{ removed: string[]; retained: string[] }> {
    if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now()) throw new StorageError('INVALID_STATE');
    const root = await this.checked(join(this.root, 'staging'), true);
    const removed: string[] = [], retained: string[] = [];
    for (const id of await readdir(root)) {
      if (!uuid.safeParse(id).success) throw new StorageError('INVALID_PATH');
      let release: () => Promise<void>;
      try { release = await this.lock(id); }
      catch (error) {
        if (z.object({ code: z.literal('EEXIST') }).safeParse(error).success) { retained.push(id); continue; }
        throw error;
      }
      try {
      const value = await this.manifest(id);
      if (new Date(value.createdAt) >= before || ['COMMITTING', 'COMMITTED'].includes(value.state)
        || await references.isReferenced(value.storageKey)) { retained.push(id); continue; }
      await this.removeStaging(id, true);
      } finally { await release(); }
      await rmdir(await this.operation(id)); removed.push(id);
    }
    return { removed, retained };
  }
}

function missing(error: unknown): boolean { return z.object({ code: z.literal('ENOENT') }).safeParse(error).success; }
