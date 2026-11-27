import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import { ModelFailure, modelResponseSchema } from './model.port.js';
import type { ModelPort, ModelResponse, ModelUsage } from './model.port.js';
import { versionNameSchema } from '../../contracts/jobs.js';

export const modelExecutionPolicySchema = z.object({
  singleTimeoutMs: z.int().positive().max(120_000), totalTimeoutMs: z.int().positive().max(600_000),
  maxAttempts: z.int().min(1).max(8), maxRetries: z.int().min(0).max(4),
  maxTokens: z.int().positive(), maxCostMicros: z.int().positive(), currency: z.string().regex(/^[A-Z]{3}$/),
  inputTokenReservation: z.int().positive(), maxOutputTokens: z.int().positive(), costReservationMicros: z.int().positive(),
  retryBaseMs: z.int().positive().max(10_000), retryCapMs: z.int().positive().max(30_000),
  maxConcurrent: z.int().min(1).max(8),
}).strict().refine(value => value.singleTimeoutMs <= value.totalTimeoutMs && value.retryBaseMs <= value.retryCapMs);
export type ModelExecutionPolicy = z.infer<typeof modelExecutionPolicySchema>;
export type ModelObservation = { modelConfigVersion: string; attempts: number; elapsedMs: number; usage: ModelResponse['usage']; status: 'ok' | 'failed' };
export type ModelReservation = { modelCalls: number; tokens: number; costMicros: number };

function accumulateUsage(previous: ModelUsage | null, next: ModelUsage, currency: string): ModelUsage {
  return { inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    costMicros: next.costMicros === null || previous?.costMicros === null ? null : (previous?.costMicros ?? 0) + next.costMicros,
    currency };
}

export class ModelExecutor {
  private active = 0;
  readonly policy: ModelExecutionPolicy;
  constructor(private readonly port: ModelPort, policy: unknown, private readonly observe?: (value: ModelObservation) => void) {
    this.policy = modelExecutionPolicySchema.parse(policy);
    versionNameSchema.parse(port.modelConfigVersion);
  }
  get modelConfigVersion() { return this.port.modelConfigVersion; }

  async run<T>(input: { messages: BaseMessage[]; schema: z.ZodType<T>; validate: (output: unknown) => T;
    repairMessages: () => BaseMessage[]; signal?: AbortSignal; deadline?: number;
    reserve?: (reservation: ModelReservation) => Promise<void> }) {
    const p = this.policy, start = Date.now(), deadline = Math.min(start + p.totalTimeoutMs, input.deadline ?? Infinity);
    if (input.signal?.aborted) throw new ModelFailure('CANCELLED');
    if (deadline <= start) throw new ModelFailure('DEADLINE_EXCEEDED');
    if (this.active >= p.maxConcurrent) throw new ModelFailure('BUSY');
    this.active++;
    const total = new AbortController(), timer = setTimeout(() => total.abort(), deadline - Date.now());
    const signal = input.signal ? AbortSignal.any([input.signal, total.signal]) : total.signal;
    let attempts = 0, retries = 0, reservedTokens = 0, reservedCost = 0, repaired = false;
    let usage: ModelResponse['usage'] = null, usageKnown = true, status: 'ok' | 'failed' = 'failed';
    let messages = input.messages, unsettled: Promise<unknown> | undefined;
    const interrupted = () => new ModelFailure(input.signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
    try {
      for (;;) {
        if (signal.aborted || Date.now() >= deadline) throw interrupted();
        // Conservative UTF-8 byte bound, including message/schema overhead; no silent unbudgeted long prompts.
        const inputBound = Buffer.byteLength(JSON.stringify(messages.map(message => ({ role: message.getType(), content: message.content }))))
          + Buffer.byteLength(JSON.stringify(z.toJSONSchema(input.schema))) + 256;
        if (inputBound > p.inputTokenReservation) throw new ModelFailure('BUDGET_EXHAUSTED');
        const tokens = p.inputTokenReservation + p.maxOutputTokens;
        if (attempts >= p.maxAttempts || tokens > p.maxTokens - reservedTokens || p.costReservationMicros > p.maxCostMicros - reservedCost) throw new ModelFailure('BUDGET_EXHAUSTED');
        // Caller may persist the reservation against a task fence; local retries/repair share that same ledger.
        if (input.reserve) {
          let remove = () => {};
          const reserved = input.reserve({ modelCalls: 1, tokens, costMicros: p.costReservationMicros });
          const aborted = new Promise<never>((_resolve, reject) => {
            const stop = () => reject(interrupted()); signal.addEventListener('abort', stop, { once: true });
            remove = () => signal.removeEventListener('abort', stop); if (signal.aborted) stop();
          });
          try { await Promise.race([reserved, aborted]); }
          catch (error) { unsettled = reserved; throw error; }
          finally { remove(); }
        }
        if (signal.aborted || Date.now() >= deadline) throw interrupted();
        attempts++; reservedTokens += tokens; reservedCost += p.costReservationMicros;
        const callAbort = new AbortController(), callSignal = AbortSignal.any([signal, callAbort.signal]);
        const callTimer = setTimeout(() => callAbort.abort(), Math.min(p.singleTimeoutMs, deadline - Date.now()));
        let removeAbort = () => {}, settled = false;
        const pending = Promise.resolve().then(() => this.port.invoke({ messages, schema: input.schema, maxOutputTokens: p.maxOutputTokens }, callSignal));
        void pending.then(() => { settled = true; }, () => { settled = true; });
        const aborted = new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.aborted ? interrupted() : new ModelFailure('TIMEOUT'));
          callSignal.addEventListener('abort', abort, { once: true }); removeAbort = () => callSignal.removeEventListener('abort', abort);
          if (callSignal.aborted) abort();
        });
        let response: ModelResponse;
        try {
          response = modelResponseSchema.parse(await Promise.race([pending, aborted]));
        } catch (error) {
          callAbort.abort();
          // No retry may overlap an invocation whose cancellation has not actually settled.
          // Give an abort-compliant transport its promise continuations, without waiting past the total deadline.
          await Promise.resolve(); await Promise.resolve();
          if (!settled) { unsettled = pending; throw new ModelFailure('UNSETTLED'); }
          if (signal.aborted || Date.now() >= deadline) throw interrupted();
          usageKnown = false; usage = null;
          const failure = error instanceof ModelFailure ? error : new ModelFailure('OUTPUT_INVALID');
          if (failure.code === 'OUTPUT_INVALID' && !repaired) { repaired = true; messages = input.repairMessages(); continue; }
          if (!['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_5XX', 'UNAVAILABLE'].includes(failure.code) || retries >= p.maxRetries) throw failure;
          const wait = Math.floor(Math.min(p.retryCapMs, p.retryBaseMs * 2 ** retries) * (0.5 + Math.random() * 0.5));
          retries++;
          if (Date.now() + wait >= deadline) throw new ModelFailure('DEADLINE_EXCEEDED');
          try { await delay(wait, undefined, { signal }); } catch { throw interrupted(); }
          continue;
        } finally { clearTimeout(callTimer); removeAbort(); }
        if (signal.aborted || Date.now() >= deadline) throw interrupted();
        if (response.usage && response.usage.currency !== p.currency) throw new ModelFailure('OUTPUT_INVALID');
        if (!response.usage) usageKnown = false;
        if (usageKnown && response.usage) usage = accumulateUsage(usage, response.usage, p.currency);
        else usage = null;
        if (response.usage && (response.usage.inputTokens > p.inputTokenReservation || response.usage.outputTokens > p.maxOutputTokens
          || response.usage.costMicros !== null && response.usage.costMicros > p.costReservationMicros)) throw new ModelFailure('BUDGET_EXHAUSTED');
        try {
          const output = input.validate(input.schema.parse(response.output));
          status = 'ok'; return { output, usage, attempts, modelConfigVersion: this.port.modelConfigVersion };
        } catch {
          if (repaired) throw new ModelFailure('OUTPUT_INVALID');
          repaired = true; messages = input.repairMessages();
        }
      }
    } finally {
      clearTimeout(timer);
      if (unsettled) void unsettled.then(() => { this.active--; }, () => { this.active--; });
      else this.active--;
      try { this.observe?.({ modelConfigVersion: this.port.modelConfigVersion, attempts, elapsedMs: Date.now() - start, usage, status }); } catch { /* observability never changes business result */ }
    }
  }
}
