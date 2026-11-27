import { z } from 'zod';
import { indexCollectionSchema, indexPointPayloadSchema } from '../../contracts/job-index.js';
import { indexAlias, indexCollectionName } from '../../modules/recall/job-chunks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { TaskFailure } from '../consumer/failure.js';
import { QDRANT_REQUEST_TIMEOUT_MS } from './request-budget.js';

export type IndexCall = { signal: AbortSignal; deadline: number };
const pointSchema = z.object({ id: z.uuid(), vector: z.array(z.number()).min(1).max(8192), payload: indexPointPayloadSchema }).strict();
export type IndexPoint = z.infer<typeof pointSchema>;
const collectionInfoSchema = z.object({ config: z.object({ metadata: indexCollectionSchema,
  params: z.object({ vectors: z.object({ size: z.int().positive(), distance: z.literal('Cosine') }) }),
}) });
const aliasesSchema = z.object({ aliases: z.array(z.object({ alias_name: z.string(), collection_name: z.string() })) });

// Qdrant 1.20 REST schemas match the installed official client. Bounded native fetch also
// propagates task cancellation: the SDK's finite-timeout middleware replaces caller signals.
export class JobIndexVector {
  private readonly url: string;
  constructor(config: { url: string; apiKey: string }, private readonly verifyInstance: (signal: AbortSignal) => Promise<void>) {
    const target = new URL(z.url().parse(config.url));
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash || target.search
      || target.pathname !== '/') throw new Error('INVALID_VECTOR_ENDPOINT');
    this.url = target.origin;
    this.apiKey = z.string().parse(config.apiKey);
  }
  private readonly apiKey: string;

  private async verifyOwnership(call: IndexCall) {
    if (call.deadline <= Date.now()) throw new TaskFailure('DEADLINE_EXCEEDED');
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(Math.max(1, call.deadline - Date.now()))]);
    await this.verifyInstance(signal); signal.throwIfAborted();
  }

  private async request(path: string, method: string, body: unknown, call: IndexCall, missing = false, wrapped = true): Promise<unknown> {
    call.signal.throwIfAborted();
    const remaining = call.deadline - Date.now();
    if (remaining <= 0) throw new TaskFailure('DEADLINE_EXCEEDED');
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(Math.min(QDRANT_REQUEST_TIMEOUT_MS, remaining))]);
    try {
      const response = await fetch(`${this.url}${path}`, { method, headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' });
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new TaskFailure(response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UPSTREAM_5XX' : 'INPUT_INVALID');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TaskFailure('OUTPUT_INVALID');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > 4 * 1024 * 1024) { await reader.cancel(); throw new TaskFailure('OUTPUT_INVALID'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      call.signal.throwIfAborted();
      if (Date.now() >= call.deadline) throw new TaskFailure('DEADLINE_EXCEEDED');
      return wrapped ? z.object({ result: z.unknown(), status: z.literal('ok') }).parse(parsed).result : parsed;
    } catch (error) {
      if (call.signal.aborted) throw error;
      if (Date.now() >= call.deadline) throw new TaskFailure('DEADLINE_EXCEEDED');
      if (error instanceof TaskFailure) throw error;
      if (signal.aborted) throw new TaskFailure('UPSTREAM_TIMEOUT');
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new TaskFailure('OUTPUT_INVALID');
      throw new TaskFailure('DEPENDENCY_UNAVAILABLE');
    }
  }

  private async inspect(name: string, call: IndexCall, missing = false) {
    const result = await this.request(`/collections/${encodeURIComponent(name)}`, 'GET', undefined, call, missing);
    return result === null ? null : collectionInfoSchema.parse(result);
  }
  async exists(raw: unknown, call: IndexCall) {
    const name = indexCollectionName(indexCollectionSchema.parse(raw));
    return z.object({ exists: z.boolean() }).parse(await this.request(`/collections/${encodeURIComponent(name)}/exists`, 'GET', undefined, call)).exists;
  }
  async listAliases(call: IndexCall) { return aliasesSchema.parse(await this.request('/aliases', 'GET', undefined, call)).aliases; }

  async query(raw: unknown, queryVector: unknown, jobVersionIds: unknown, limit: number, call: IndexCall) {
    const spec = await this.verify(raw, call), vector = z.array(z.number()).length(spec.dimensions).parse(queryVector);
    const ids = z.array(z.uuid()).min(1).max(10_000).parse(jobVersionIds), take = z.int().min(1).max(1000).parse(limit);
    const result = await this.request(`/collections/${encodeURIComponent(indexCollectionName(spec))}/points/query`, 'POST', {
      query: vector, limit: take + 1, params: { exact: true }, with_payload: true, with_vector: false,
      filter: { must: [{ key: 'ownerId', match: { value: spec.ownerId } }, { key: 'visibility', match: { value: 'private' } },
        { key: 'embeddingVersion', match: { value: spec.embeddingVersion } }, { key: 'indexVersion', match: { value: spec.indexVersion } },
        { key: 'jobVersionId', match: { any: ids } }] },
    }, call);
    const points = z.object({ points: z.array(z.object({ id: z.uuid(), score: z.number(), payload: indexPointPayloadSchema })).max(take + 1) }).parse(result).points;
    if (points.some(point => point.payload.ownerId !== spec.ownerId || point.payload.embeddingVersion !== spec.embeddingVersion
      || point.payload.indexVersion !== spec.indexVersion || !ids.includes(point.payload.jobVersionId))) throw new TaskFailure('OUTPUT_INVALID');
    points.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // A capped tied boundary would select an arbitrary subset; fail into the explicit fallback policy.
    if (points.length > take && points[take - 1]!.score === points[take]!.score) throw new TaskFailure('OUTPUT_INVALID');
    return points.slice(0, take);
  }
  async verify(raw: unknown, call: IndexCall) {
    const spec = indexCollectionSchema.parse(raw), info = await this.inspect(indexCollectionName(spec), call);
    if (!info || requestHash(info.config.metadata) !== requestHash(spec) || info.config.params.vectors.size !== spec.dimensions) {
      throw new TaskFailure('INPUT_INVALID');
    }
    return spec;
  }
  async ensure(raw: unknown, call: IndexCall) {
    const spec = indexCollectionSchema.parse(raw), name = indexCollectionName(spec);
    await this.verifyOwnership(call);
    // This adapter targets the project's pinned 1.20 API, including collection metadata.
    z.object({ version: z.string().regex(/^1\.20\.\d+(?:[-+].*)?$/) }).parse(await this.request('/', 'GET', undefined, call, false, false));
    const existing = await this.inspect(name, call, true);
    if (!existing) {
      try {
        const created = await this.request(`/collections/${encodeURIComponent(name)}`, 'PUT',
          { vectors: { size: spec.dimensions, distance: 'Cosine' }, metadata: spec }, call);
        if (created !== true) throw new TaskFailure('OUTPUT_INVALID');
      } catch (error) {
        // Creation may have committed despite a lost reply or a concurrent matching create.
        // Adopt only matching metadata; otherwise preserve the original safe failure for retry.
        try { await this.verify(spec, call); return name; } catch { throw error; }
      }
    }
    await this.verify(spec, call);
    return name;
  }

  async upsert(raw: unknown, rawPoints: unknown, call: IndexCall) {
    const spec = await this.verify(raw, call), points = z.array(pointSchema).min(1).max(64).parse(rawPoints);
    if (points.some(point => point.vector.length !== spec.dimensions || point.payload.ownerId !== spec.ownerId
      || point.payload.embeddingVersion !== spec.embeddingVersion || point.payload.indexVersion !== spec.indexVersion)) throw new TaskFailure('INPUT_INVALID');
    const result = await this.request(`/collections/${encodeURIComponent(indexCollectionName(spec))}/points?wait=true`, 'PUT', { points }, call);
    z.object({ status: z.literal('completed') }).parse(result);
  }

  async switchAlias(raw: unknown, call: IndexCall) {
    await this.verifyOwnership(call);
    const spec = await this.verify(raw, call), alias = indexAlias(spec.ownerId), name = indexCollectionName(spec);
    const aliases = aliasesSchema.parse(await this.request('/aliases', 'GET', undefined, call));
    const current = aliases.aliases.find(item => item.alias_name === alias);
    if (current?.collection_name === name) return;
    if (current) {
      const info = await this.inspect(current.collection_name, call);
      if (!info || info.config.metadata.ownerId !== spec.ownerId || indexCollectionName(info.config.metadata) !== current.collection_name) throw new TaskFailure('INPUT_INVALID');
    }
    const result = await this.request('/collections/aliases', 'POST', { actions: [
      ...(current ? [{ delete_alias: { alias_name: alias } }] : []),
      { create_alias: { alias_name: alias, collection_name: name } },
    ] }, call);
    if (result !== true) throw new TaskFailure('OUTPUT_INVALID');
  }

  async removeAlias(raw: unknown, call: IndexCall) {
    await this.verifyOwnership(call); const spec = await this.verify(raw, call), alias = indexAlias(spec.ownerId);
    const aliases = aliasesSchema.parse(await this.request('/aliases', 'GET', undefined, call));
    const current = aliases.aliases.find(item => item.alias_name === alias);
    if (!current) return;
    if (current.collection_name !== indexCollectionName(spec)) throw new TaskFailure('INPUT_INVALID');
    if (await this.request('/collections/aliases', 'POST', { actions: [{ delete_alias: { alias_name: alias } }] }, call) !== true) throw new TaskFailure('OUTPUT_INVALID');
  }

  async remove(raw: unknown, call: IndexCall) {
    await this.verifyOwnership(call);
    const requested = indexCollectionSchema.parse(raw);
    if (!await this.inspect(indexCollectionName(requested), call, true)) return;
    const spec = await this.verify(requested, call), name = indexCollectionName(spec);
    const aliases = aliasesSchema.parse(await this.request('/aliases', 'GET', undefined, call));
    if (aliases.aliases.some(item => item.collection_name === name)) throw new TaskFailure('INPUT_INVALID');
    if (await this.request(`/collections/${encodeURIComponent(name)}`, 'DELETE', undefined, call) !== true) throw new TaskFailure('OUTPUT_INVALID');
  }
}
