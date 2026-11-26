import busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import { BadRequestException } from '@nestjs/common';
import { ParseFailure } from '../../modules/parsing/contracts.js';
import { StorageError } from '../../modules/storage/storage.port.js';
import type { StagedFile, StoragePort } from '../../modules/storage/storage.port.js';

export async function receiveResume(request: IncomingMessage, storage: StoragePort, signal: AbortSignal): Promise<{ file: StagedFile; filename: string; mime: string }> {
  let parser;
  try { parser = busboy({ headers: request.headers, limits: { files: 1, fields: 0, parts: 2, fileSize: 10 * 1024 * 1024 + 1, headerPairs: 100 } }); }
  catch { throw new BadRequestException(); }
  let staged: StagedFile | undefined, filename = '', mime = '', failure: unknown, seen = false;
  let pending: Promise<void> = Promise.resolve();
  const abort = () => { parser.destroy(new Error('UPLOAD_ABORTED')); };
  const timer = setTimeout(abort, 30_000);
  signal.addEventListener('abort', abort, { once: true });
  const completed = new Promise<void>((resolve, reject) => {
    parser.once('close', resolve); parser.once('error', reject);
    parser.on('filesLimit', () => { failure = new BadRequestException(); });
    parser.on('fieldsLimit', () => { failure = new BadRequestException(); });
    parser.on('partsLimit', () => { failure = new BadRequestException(); });
    parser.on('file', (field, stream, info) => {
      if (seen || field !== 'file') { failure = new BadRequestException(); stream.resume(); return; }
      seen = true; filename = info.filename ?? ''; mime = info.mimeType;
      stream.once('limit', () => { failure = new ParseFailure('FILE_TOO_LARGE'); });
      pending = storage.stage(stream, signal).then(file => { staged = file; })
        .catch(error => { failure = error instanceof StorageError && error.code === 'EMPTY_FILE' ? new ParseFailure('EMPTY_TEXT') : error; parser.destroy(new Error('UPLOAD_REJECTED')); });
    });
  });
  request.pipe(parser);
  try {
    await completed; await pending;
    if (failure) throw failure;
    if (!staged || !seen || !filename) throw new BadRequestException();
    signal.throwIfAborted();
    return { file: staged, filename, mime };
  } catch (error) {
    await pending;
    if (staged) await storage.discard(staged).catch(() => undefined);
    throw failure ?? error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); request.unpipe(parser); }
}
