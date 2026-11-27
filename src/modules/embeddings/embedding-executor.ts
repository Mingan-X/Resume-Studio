import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { versionNameSchema } from '../../contracts/jobs.js';
import { redactContactText } from '../models/privacy.js';
import { EmbeddingFailure, embeddingResponseSchema } from './embedding.port.js';
import type { EmbeddingPort } from './embedding.port.js';

export const embeddingPolicySchema = z.object({ singleTimeoutMs: z.int().positive().max(120_000),
  totalTimeoutMs: z.int().positive().max(600_000), maxAttempts: z.int().min(1).max(5),
  retryBaseMs: z.int().positive().max(10_000), retryCapMs: z.int().positive().max(30_000),
  maxConcurrent: z.int().min(1).max(8), inputTokenReservation: z.int().positive(),
  costReservationMicros: z.int().positive(), maxTokens: z.int().positive(), maxCostMicros: z.int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict().refine(value => value.singleTimeoutMs <= value.totalTimeoutMs && value.retryBaseMs <= value.retryCapMs);
export type EmbeddingReservation = { modelCalls: number; tokens: number; costMicros: number };

export class EmbeddingExecutor {
  private active = 0;
  readonly policy: z.infer<typeof embeddingPolicySchema>;
  readonly embeddingVersion: string;
  readonly dimensions: number;
  readonly provenance: EmbeddingPort['provenance'];
  constructor(private readonly port: EmbeddingPort, policy: unknown) {
    this.policy = embeddingPolicySchema.parse(policy);
    this.embeddingVersion = versionNameSchema.parse(port.embeddingVersion);
    this.dimensions = z.int().min(1).max(8192).parse(port.dimensions);
    this.provenance = z.enum(['synthetic', 'bailian']).parse(port.provenance);
  }

  async run(rawTexts: unknown, options: { signal?: AbortSignal; deadline?: number;
    reserve?: (usage: EmbeddingReservation) => Promise<void> } = {}) {
    const texts = z.array(z.string().trim().min(1).max(20_000)).min(1).max(64).parse(rawTexts).map(text => redactContactText(text));
    const p = this.policy, started = Date.now(), deadline = Math.min(started + p.totalTimeoutMs, options.deadline ?? Infinity);
    if (!Number.isFinite(deadline)) throw new EmbeddingFailure('DEADLINE_EXCEEDED');
    if (options.signal?.aborted) throw new EmbeddingFailure('CANCELLED');
    if (deadline <= started) throw new EmbeddingFailure('DEADLINE_EXCEEDED');
    if (this.active >= p.maxConcurrent) throw new EmbeddingFailure('BUSY');
    // UTF-8 bytes conservatively reserve input tokens, including provider envelope overhead.
    if (Buffer.byteLength(JSON.stringify(texts)) + 256 > p.inputTokenReservation) throw new EmbeddingFailure('BUDGET_EXHAUSTED');
    this.active++;
    const total = new AbortController(), timer = setTimeout(() => total.abort(), deadline - Date.now());
    const signal = options.signal ? AbortSignal.any([options.signal, total.signal]) : total.signal;
    const interrupted = () => new EmbeddingFailure(options.signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
    let attempts = 0, reservedTokens = 0, reservedCost = 0, unsettled: Promise<unknown> | undefined;
    let usageKnown = true;
    try {
      for (;;) {
        if (signal.aborted || Date.now() >= deadline) throw interrupted();
        if (attempts >= p.maxAttempts || p.inputTokenReservation > p.maxTokens - reservedTokens
          || p.costReservationMicros > p.maxCostMicros - reservedCost) throw new EmbeddingFailure('BUDGET_EXHAUSTED');
        if (options.reserve) {
          const pending = options.reserve({ modelCalls: 1, tokens: p.inputTokenReservation, costMicros: p.costReservationMicros });
          let remove = () => {};
          const aborted = new Promise<never>((_resolve, reject) => {
            const stop = () => reject(interrupted()); signal.addEventListener('abort', stop, { once: true });
            remove = () => signal.removeEventListener('abort', stop); if (signal.aborted) stop();
          });
          try { await Promise.race([pending, aborted]); }
          catch (error) { unsettled = pending; throw error; }
          finally { remove(); }
        }
        if (signal.aborted || Date.now() >= deadline) throw interrupted();
        attempts++; reservedTokens += p.inputTokenReservation; reservedCost += p.costReservationMicros;
        const call = new AbortController(), callSignal = AbortSignal.any([signal, call.signal]);
        const callTimer = setTimeout(() => call.abort(), Math.min(p.singleTimeoutMs, deadline - Date.now()));
        let settled = false, remove = () => {};
        const pending = Promise.resolve().then(() => this.port.embed(texts, callSignal));
        void pending.then(() => { settled = true; }, () => { settled = true; });
        const aborted = new Promise<never>((_resolve, reject) => {
          const stop = () => reject(signal.aborted ? interrupted() : new EmbeddingFailure('TIMEOUT'));
          callSignal.addEventListener('abort', stop, { once: true }); remove = () => callSignal.removeEventListener('abort', stop);
          if (callSignal.aborted) stop();
        });
        try {
          const result = embeddingResponseSchema.parse(await Promise.race([pending, aborted]));
          if (result.vectors.length !== texts.length || result.vectors.some(vector => vector.length !== this.dimensions)) throw new EmbeddingFailure('OUTPUT_INVALID');
          if (result.usage && (result.usage.currency !== p.currency || result.usage.inputTokens > p.inputTokenReservation
            || (result.usage.costMicros !== null && result.usage.costMicros > p.costReservationMicros))) throw new EmbeddingFailure('BUDGET_EXHAUSTED');
          if (signal.aborted || Date.now() >= deadline) throw interrupted();
          return { ...result, usage: usageKnown ? result.usage : null, attempts, embeddingVersion: this.embeddingVersion,
            dimensions: this.dimensions, elapsedMs: Date.now() - started };
        } catch (error) {
          call.abort();
          await Promise.resolve(); await Promise.resolve();
          if (!settled) { unsettled = pending; throw new EmbeddingFailure('UNSETTLED'); }
          if (signal.aborted || Date.now() >= deadline) throw interrupted();
          usageKnown = false;
          const failure = error instanceof EmbeddingFailure ? error : new EmbeddingFailure('OUTPUT_INVALID');
          if (!['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_5XX', 'UNAVAILABLE'].includes(failure.code) || attempts >= p.maxAttempts) throw failure;
          const wait = Math.floor(Math.min(p.retryCapMs, p.retryBaseMs * 2 ** (attempts - 1)) * (0.5 + Math.random() * 0.5));
          if (Date.now() + wait >= deadline) throw new EmbeddingFailure('DEADLINE_EXCEEDED');
          try { await delay(wait, undefined, { signal }); } catch { throw interrupted(); }
        } finally { clearTimeout(callTimer); remove(); }
      }
    } finally {
      clearTimeout(timer); total.abort();
      if (unsettled) void unsettled.then(() => { this.active--; }, () => { this.active--; });
      else this.active--;
    }
  }
}
