import type { Readable } from 'node:stream';
import { z } from 'zod';
import { sha256Schema } from '../../contracts/evidence.js';

export const stagedFileSchema = z.object({
  operationId: z.uuid(), storageKey: z.uuid(), sha256: sha256Schema, size: z.int().positive(),
}).strict();
export type StagedFile = z.infer<typeof stagedFileSchema>;
export interface StorageReferencePort {
  // Must query the authoritative database, failing closed on errors.
  isReferenced(storageKey: string): Promise<boolean>;
}
export interface StoragePort {
  stage(input: Readable, signal?: AbortSignal): Promise<StagedFile>;
  commit(file: StagedFile): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  readStaged(file: StagedFile): Promise<Buffer>;
  compensate(file: StagedFile, references: StorageReferencePort): Promise<void>;
  discard(file: StagedFile): Promise<void>;
  inspect(operationId: string): Promise<unknown>;
  reclaim(before: Date, references: StorageReferencePort): Promise<{ removed: string[]; retained: string[] }>;
}
export class StorageError extends Error {
  constructor(readonly code: 'INVALID_PATH' | 'FILE_TOO_LARGE' | 'EMPTY_FILE' | 'STORAGE_IO' | 'INVALID_STATE') {
    super(code); this.name = 'StorageError';
  }
}
