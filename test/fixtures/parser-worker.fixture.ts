import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { z } from 'zod';
import { restrictParserNetwork } from '../../src/infrastructure/parsing/restrict-network.js';
import { parserRequestSchema } from '../../src/modules/parsing/contracts.js';
restrictParserNetwork();
const parts: Buffer[] = [];
for await (const chunk of process.stdin) if (Buffer.isBuffer(chunk)) parts.push(chunk);
const request = parserRequestSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown);
if (request.filename === 'loop') { while (true) { /* exercises actual child termination */ } }
if (request.filename === 'memory') {
  const buffers = [Buffer.alloc(96 * 1024 * 1024, 1)];
  setInterval(() => { process.stdout.write(String(buffers[0]?.[0])); }, 1000);
} else if (request.filename === 'invalid') process.stdout.write('not-json');
else if (request.filename === 'heap') {
  const arrays: number[][] = []; while (true) arrays.push(Array<number>(1_000_000).fill(1));
} else {
  let networkBlocked = false, fileBlocked = false;
  try { connect(12345, '127.0.0.1'); } catch { networkBlocked = true; }
  try { await readFile('.env'); } catch (error) { fileBlocked = z.object({ code: z.literal('ERR_ACCESS_DENIED') }).safeParse(error).success; }
  if (!networkBlocked || !fileBlocked || process.env.DATABASE_URL) throw new Error('isolation failed');
  process.stdout.write(JSON.stringify({ ok: true, value: { parserVersion: 'fixture-v1',
    blocks: [{ text: request.filename === 'long' ? 'x'.repeat(20) : '中文😀', location: { kind: 'TEXT', paragraph: 0 } }], warnings: [] } }));
}
