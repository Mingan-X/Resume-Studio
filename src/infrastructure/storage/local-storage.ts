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
  uploaderPid: z.int().positive().optional(),
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
    const release = await this.lock(operationId);
    const value: Manifest = { schemaVersion: 1, operationId, storageKey,
      createdAt: new Date().toISOString(), state: 'WRITING', size: 0, sha256: '', uploaderPid: process.pid };
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
      // An I/O error during cleanup leaves the exact operation manifest for inspection.
      try{await handle?.close();await release();await this.removeStaging(operationId);}
      catch{throw new Error('UPLOAD_CLEANUP_UNCONFIRMED');}
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await release().catch(error => { if (!missing(error)) throw new Error('UPLOAD_CLEANUP_UNCONFIRMED'); });
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

  // Caller owns a durable deletion barrier and has confirmed all writers stopped.
  async eraseOwned(storageKey:string,sha256:string,size:number,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();
    uuid.parse(storageKey);z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);z.int().positive().parse(size);
    const directory=join(this.root,'files',storageKey);
    try{
      await this.checked(directory,true);const names=await readdir(directory);
      if(names.some(name=>name!=='payload'))throw new StorageError('INVALID_PATH');
      if(names.includes('payload')){const bytes=await this.read(storageKey);if(bytes.length!==size||createHash('sha256').update(bytes).digest('hex')!==sha256)throw new StorageError('INVALID_STATE');
        signal?.throwIfAborted();await unlink(await this.checked(join(directory,'payload'),false));}
      await rmdir(directory);
    }catch(error){if(!missing(error))throw error;}
    const root=await this.checked(join(this.root,'staging'),true);
    for(const id of await readdir(root)){
      signal?.throwIfAborted();
      uuid.parse(id);const path=await this.operation(id),marker=join(path,'deletion.json');let value:Manifest;
      try{value=await this.manifest(id);}catch(error){
        if(!missing(error))throw error;
        try{value=manifestSchema.parse(JSON.parse(await readFile(await this.checked(marker,false),'utf8')) as unknown);}
        catch(markerError){if(!missing(markerError))throw markerError;
          if((await readdir(path)).every(name=>name==='lock'))continue;throw new StorageError('INVALID_STATE');}
      }
      if(value.operationId!==id)throw new StorageError('INVALID_STATE');if(value.storageKey!==storageKey)continue;
      if(value.sha256!==sha256||value.size!==size)throw new StorageError('INVALID_STATE');
      await this.recoverDeadLock(id);const release=await this.lock(id);
      try{
        try{const handle=await open(marker,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}}
        catch(error){if(!z.object({code:z.literal('EEXIST')}).safeParse(error).success)throw error;}
        const names=(await readdir(path)).filter(name=>!['lock','deletion.json'].includes(name));
        for(const name of names){if(name!=='payload'&&name!=='manifest.json'&&!/^[a-f0-9-]{36}\.json\.tmp$/.test(name))throw new StorageError('INVALID_PATH');await this.checked(join(path,name),false);}
        for(const name of names){signal?.throwIfAborted();await unlink(await this.checked(join(path,name),false));}
        await unlink(await this.checked(marker,false));
      }finally{await release();}
      await rmdir(await this.operation(id));
    }
  }

  async readStaged(input: StagedFile): Promise<Buffer> {
    const file = stagedFileSchema.parse(input), value = await this.manifest(file.operationId);
    this.matches(value, file);
    if (value.state !== 'READY') throw new StorageError('INVALID_STATE');
    const path = await this.checked(join(await this.operation(file.operationId), 'payload'), false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size !== file.size) throw new StorageError('INVALID_STATE');
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new StorageError('INVALID_STATE');
      return bytes;
    } finally { await handle.close(); }
  }

  // Explicit upload compensation only; caller must have settled its DB transaction.
  async compensate(input: StagedFile, references: StorageReferencePort): Promise<void> {
    const file = stagedFileSchema.parse(input), release = await this.lock(file.operationId);
    try {
      const value = await this.manifest(file.operationId); this.matches(value, file);
      if (await references.isReferenced(file.storageKey)) return;
      if (value.state === 'COMMITTED' || value.state === 'COMMITTING') {
        const directory = join(this.root, 'files', file.storageKey);
        try {
          await this.checked(directory, true);
          const names = await readdir(directory);
          if (names.some(name => name !== 'payload')) throw new StorageError('INVALID_PATH');
          if (names.length) await unlink(await this.checked(join(directory, 'payload'), false));
          await rmdir(directory);
        } catch (error) { if (!missing(error)) throw error; }
      }
      await this.removeStaging(file.operationId, true);
    } finally { await release(); }
    // A referenced file retains its manifest; return above skips this removal.
    await rmdir(await this.operation(file.operationId));
  }

  private async lock(id: string): Promise<() => Promise<void>> {
    const path = join(await this.operation(id), 'lock');
    await mkdir(path, { mode: 0o700 });
    const marker = join(path, 'owner.json'), handle = await open(marker, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
    return async () => {
      await unlink(await this.checked(marker, false));
      await rmdir(await this.checked(path, true));
    };
  }

  private async recoverDeadLock(id: string): Promise<void> {
    const path = join(await this.operation(id), 'lock');
    try {
      await this.checked(path, true);
      const marker = await this.checked(join(path, 'owner.json'), false);
      const owner = z.object({ pid: z.int().positive() }).strict().parse(JSON.parse(await readFile(marker, 'utf8')) as unknown);
      try { process.kill(owner.pid, 0); return; }
      catch (error) { if (!z.object({ code: z.literal('ESRCH') }).safeParse(error).success) return; }
      // A reused PID is conservatively retained. Only absence proves the old process ended.
      await unlink(marker); await rmdir(path);
    } catch (error) { if (!missing(error)) throw error; }
  }

  async reconcileUploads(before: Date, references: StorageReferencePort): Promise<{ removed: string[]; retained: string[] }> {
    if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now() - 60_000) throw new StorageError('INVALID_STATE');
    const root = await this.checked(join(this.root, 'staging'), true), removed: string[] = [], retained: string[] = [];
    for (const id of await readdir(root)) {
      const value = await this.manifest(id);
      if (new Date(value.createdAt) >= before) { retained.push(id); continue; }
      if (!value.uploaderPid) { retained.push(id); continue; }
      try { process.kill(value.uploaderPid, 0); retained.push(id); continue; }
      catch (error) { if (!z.object({ code: z.literal('ESRCH') }).safeParse(error).success) { retained.push(id); continue; } }
      await this.recoverDeadLock(id);
      if (await references.isReferenced(value.storageKey)) { retained.push(id); continue; }
      try {
        if (value.state === 'WRITING') {
          const release = await this.lock(id);
          try { if (await references.isReferenced(value.storageKey)) { retained.push(id); continue; } await this.removeStaging(id, true); }
          finally { await release(); }
          await rmdir(await this.operation(id));
        } else await this.compensate({ operationId: value.operationId, storageKey: value.storageKey, size: value.size, sha256: value.sha256 }, references);
        removed.push(id);
      } catch (error) {
        if (z.object({ code: z.literal('EEXIST') }).safeParse(error).success) retained.push(id); else throw error;
      }
    }
    return { removed, retained };
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
