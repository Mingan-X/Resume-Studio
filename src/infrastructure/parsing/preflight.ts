import { extname } from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { ParseFailure } from '../../modules/parsing/contracts.js';
import type { ParserLimits } from '../../modules/parsing/contracts.js';

const ole = Buffer.from('d0cf11e0a1b11ae1', 'hex');
export function documentType(bytes: Buffer, filename: string, mime: string, limits: ParserLimits): 'PDF' | 'DOCX' {
  if (bytes.length > limits.maxBytes) throw new ParseFailure('FILE_TOO_LARGE');
  if (!bytes.length) throw new ParseFailure('EMPTY_TEXT');
  if (bytes.subarray(0, 8).equals(ole)) {
    throw new ParseFailure(extname(filename).toLowerCase() === '.docx' ? 'ENCRYPTED_FILE' : 'UNSUPPORTED_TYPE');
  }
  const extension = extname(filename).toLowerCase();
  if (!['.pdf', '.docx'].includes(extension)) throw new ParseFailure('UNSUPPORTED_TYPE');
  const pdf = extension === '.pdf';
  if (mime !== (pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
    throw new ParseFailure('SIGNATURE_MISMATCH');
  }
  if (pdf ? !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) : bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new ParseFailure('SIGNATURE_MISMATCH');
  }
  return pdf ? 'PDF' : 'DOCX';
}

function safeEntry(entry: Entry): void {
  const name = entry.fileName;
  const unixMode = entry.externalFileAttributes >>> 16;
  if (!name || name.includes('\\') || name.startsWith('/') || name.includes(':') || name.includes('\0')
    || name.split('/').some(segment => segment === '..' || segment === '.')
    || (unixMode & 0xf000) === 0xa000 || (entry.generalPurposeBitFlag & 1) !== 0
    || ![0, 8].includes(entry.compressionMethod)
    || /\.(?:zip|docx|docm|xlsx|pptx|7z|rar|gz|tar)$/i.test(name)
    || /(?:^|\/)vbaProject\.bin$/i.test(name)) throw new ParseFailure('UNSAFE_ARCHIVE');
}

export async function preflightDocx(bytes: Buffer, limits: ParserLimits): Promise<void> {
  let zip: ZipFile | undefined;
  try {
    zip = await new Promise<ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => {
        if (error || !value) reject(new ParseFailure('CORRUPT_FILE')); else resolve(value);
      });
    });
    const archive = zip;
    await new Promise<void>((resolve, reject) => {
      let count = 0, total = 0, failed = false;
      const names = new Set<string>();
      const fail = (error: unknown) => { if (failed) return; failed = true; archive.close(); reject(error); };
      archive.on('error', () => fail(new ParseFailure('CORRUPT_FILE')));
      archive.once('end', () => {
        if (!names.has('[Content_Types].xml') || !names.has('_rels/.rels') || !names.has('word/document.xml')) {
          fail(new ParseFailure('CORRUPT_FILE'));
        } else if (!failed) resolve();
      });
      archive.on('entry', (entry: Entry) => {
        try {
          safeEntry(entry);
          if (++count > limits.maxEntries || names.has(entry.fileName)) throw new ParseFailure('ZIP_LIMIT');
          names.add(entry.fileName);
          if (entry.uncompressedSize > limits.maxEntryBytes) throw new ParseFailure('ZIP_LIMIT');
          archive.openReadStream(entry, (error, stream) => {
            if (error || !stream) { fail(new ParseFailure('CORRUPT_FILE')); return; }
            let size = 0, checksum = 0;
            const chunks: Buffer[] = [];
            let prefix = Buffer.alloc(0);
            const xml = /\.(?:xml|rels)$/i.test(entry.fileName);
            stream.on('data', (chunk: Buffer) => {
              if (failed) { stream.destroy(); return; }
              size += chunk.length; total += chunk.length;
              if (size > limits.maxEntryBytes || total > limits.maxExpandedBytes
                || size > Math.max(1, entry.compressedSize) * limits.maxCompressionRatio) {
                stream.destroy(); fail(new ParseFailure('ZIP_LIMIT')); return;
              }
              checksum = crc32(chunk, checksum);
              if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
              if (xml) chunks.push(chunk);
            });
            stream.once('error', () => fail(new ParseFailure('CORRUPT_FILE')));
            stream.once('end', () => {
              if (failed) return;
              if (size !== entry.uncompressedSize || checksum !== entry.crc32) { fail(new ParseFailure('CORRUPT_FILE')); return; }
              if (prefix.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) || prefix.subarray(0, 2).equals(Buffer.from('1f8b', 'hex'))
                || prefix.subarray(0, 6).equals(Buffer.from('377abcaf271c', 'hex'))) { fail(new ParseFailure('UNSAFE_ARCHIVE')); return; }
              if (xml) {
                // Reject XML entity expansion and external relationships before Mammoth sees the package.
                // UTF-16 XML is rejected rather than allowing alternate encoding to bypass these checks.
                const value = Buffer.concat(chunks).toString('utf8');
                if (value.includes('\0') || /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(value)
                  || /<Relationship\b[^>]*\bTarget\s*=\s*["'](?:[a-z]+:|\/\/|\/|\.\.)/i.test(value)
                  || /macroEnabled/i.test(value)) { fail(new ParseFailure('UNSAFE_ARCHIVE')); return; }
              }
              archive.readEntry();
            });
          });
        } catch (error) { fail(error); }
      });
      archive.readEntry();
    });
  } catch (error) { throw error instanceof ParseFailure ? error : new ParseFailure('CORRUPT_FILE'); }
  finally { zip?.close(); }
}
