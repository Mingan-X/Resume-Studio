import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { ParseFailure, parserLimitsSchema, parserRequestSchema, parserResponseSchema } from '../../modules/parsing/contracts.js';
import type { ParserLimits, ParserOutput, ParserPort } from '../../modules/parsing/contracts.js';

const execute = promisify(execFile);
async function residentBytes(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match?.[1]) throw new Error('PARSER_RESOURCE_MONITOR_FAILED');
    return Number(match[1]) * 1024;
  }
  if (process.platform === 'win32') {
    const result = await execute('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 3000, windowsHide: true });
    const columns = [...result.stdout.matchAll(/"([^"]*)"/g)].map(match => match[1]);
    if (Number(columns[1]) !== pid || !columns[4]) throw new Error('PARSER_RESOURCE_MONITOR_FAILED');
    return Number(columns[4].replace(/[^0-9]/g, '')) * 1024;
  }
  throw new Error('PARSER_RESOURCE_MONITOR_UNSUPPORTED');
}

// Entry is selected by server assembly/tests, never accepted from HTTP or document content.
export class IsolatedParser implements ParserPort {
  private busy = false;
  readonly limits: ParserLimits;
  constructor(limits: Partial<ParserLimits> = {}, private readonly entry = new URL('./worker.js', import.meta.url),
    private readonly onSpawn?: (pid: number) => void) {
    this.limits = parserLimitsSchema.parse(limits);
  }
  async parse(bytes: Buffer, filename: string, mime: string, signal?: AbortSignal): Promise<ParserOutput> {
    signal?.throwIfAborted();
    if (this.busy) throw new Error('PARSER_BUSY');
    if (bytes.length > this.limits.maxBytes) throw new ParseFailure('FILE_TOO_LARGE');
    const request = parserRequestSchema.parse({ filename, mime, content: bytes.toString('base64'), limits: this.limits });
    this.busy = true;
    try { return await this.run(request, signal); }
    finally { this.busy = false; }
  }
  private run(request: z.infer<typeof parserRequestSchema>, signal?: AbortSignal): Promise<ParserOutput> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        '--permission', `--allow-fs-read=${resolve('dist')}`, `--allow-fs-read=${resolve('node_modules')}`,
        `--max-old-space-size=${this.limits.heapMiB}`, fileURLToPath(this.entry),
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, LANGSMITH_TRACING: 'false' } });
      if (child.pid) this.onSpawn?.(child.pid);
      let failure: Error | undefined, output = '', outputBytes = 0, closed = false, heapExceeded = false;
      let monitor: Promise<void> = Promise.resolve(), checking = false;
      const stop = (error: Error) => { failure ??= error; if (!closed) child.kill('SIGKILL'); };
      const abort = () => stop(new Error('PARSER_ABORTED'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const deadline = setTimeout(() => stop(new ParseFailure('PARSER_TIMEOUT')), this.limits.timeoutMs);
      const poll = setInterval(() => {
        if (closed || checking || !child.pid) return;
        checking = true;
        monitor = residentBytes(child.pid).then(bytes => {
          if (!closed && bytes > this.limits.rssMiB * 1024 * 1024) stop(new ParseFailure('PARSER_MEMORY_LIMIT'));
        }).catch(() => { if (!closed && child.exitCode === null && child.signalCode === null) stop(new Error('PARSER_RESOURCE_MONITOR_FAILED')); })
          .finally(() => { checking = false; });
      }, 250);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        outputBytes += Buffer.byteLength(data);
        if (outputBytes > 4 * 1024 * 1024) { stop(new ParseFailure('TEXT_LIMIT')); return; }
        output += data;
      });
      // Drain but never expose parser stderr, paths, content, or inherited credentials.
      child.stderr.on('data', (data: Buffer) => { if (/heap out of memory|Allocation failed/i.test(data.toString())) heapExceeded = true; });
      child.stdin.on('error', () => { if (!closed) stop(new ParseFailure('CORRUPT_FILE')); });
      child.once('error', () => stop(new Error('PARSER_START_FAILED')));
      child.once('close', (code) => {
        closed = true; clearTimeout(deadline); clearInterval(poll); signal?.removeEventListener('abort', abort);
        void monitor.then(() => {
          if (failure) { reject(failure); return; }
          if (code !== 0) { reject(new ParseFailure(heapExceeded ? 'PARSER_MEMORY_LIMIT' : 'CORRUPT_FILE')); return; }
          try {
            const response = parserResponseSchema.parse(JSON.parse(output) as unknown);
            if (!response.ok) throw new ParseFailure(response.reason);
            if (response.value.blocks.reduce((sum, block) => sum + block.text.length, 0) > this.limits.maxText) throw new ParseFailure('TEXT_LIMIT');
            resolveResult(response.value);
          } catch (error) { reject(error instanceof ParseFailure ? error : new ParseFailure('CORRUPT_FILE')); }
        });
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
