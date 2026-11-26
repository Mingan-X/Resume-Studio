import { parserRequestSchema, parserResponseSchema, ParseFailure } from '../../modules/parsing/contracts.js';
import { restrictParserNetwork } from './restrict-network.js';
import { documentType, preflightDocx } from './preflight.js';
restrictParserNetwork();
console.log = () => {};
console.warn = () => {};
try {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new ParseFailure('CORRUPT_FILE');
    size += chunk.length;
    if (size > 15 * 1024 * 1024) throw new ParseFailure('FILE_TOO_LARGE');
    parts.push(chunk);
  }
  const request = parserRequestSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown);
  const bytes = Buffer.from(request.content, 'base64');
  if (bytes.toString('base64') !== request.content) throw new ParseFailure('CORRUPT_FILE');
  const type = documentType(bytes, request.filename, request.mime, request.limits);
  if (type === 'DOCX') await preflightDocx(bytes, request.limits);
  throw new ParseFailure('UNSUPPORTED_TYPE');
} catch (error) {
  process.stdout.write(JSON.stringify(parserResponseSchema.parse({ ok: false,
    reason: error instanceof ParseFailure ? error.reason : 'CORRUPT_FILE' })));
}
