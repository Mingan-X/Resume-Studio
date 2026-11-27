import type { IdentityPort } from '../identity/identity.module.js';
import { ownerIdSchema } from '../identity/identity.module.js';
import { recallConfigSchema, recallQuerySchema, recallResultSchema } from '../../contracts/recall.js';
import { indexCollectionSchema } from '../../contracts/job-index.js';
import { jdDocumentSchema } from '../../contracts/jobs.js';
import type { KeywordRecallRepository } from '../../infrastructure/jobs/keyword-recall.repository.js';
import type { JobIndexRepository } from '../../infrastructure/jobs/index.repository.js';
import type { JobIndexVector } from '../../infrastructure/vector/job-index.vector.js';
import type { EmbeddingExecutor } from '../embeddings/embedding-executor.js';
import type { EmbeddingReservation } from '../embeddings/embedding-executor.js';
import { EmbeddingFailure } from '../embeddings/embedding.port.js';
import { fuseRecall } from './rrf.js';

export class RecallFailure extends Error {}
export class RecallService {
  constructor(private readonly identity: IdentityPort, private readonly keyword: Pick<KeywordRecallRepository, 'recall'>,
    private readonly indexes: Pick<JobIndexRepository, 'assertCorpusReady' | 'visibleVersions' | 'validCandidates'>,
    private readonly embedding: EmbeddingExecutor, private readonly vector: Pick<JobIndexVector, 'query'>) {}

  async recall(rawQuery: unknown, rawConfig: unknown, rawSpec: unknown,
    options: { signal?: AbortSignal; deadline?: number; reserve?: (usage: EmbeddingReservation) => Promise<void> } = {}) {
    const query = recallQuerySchema.parse(rawQuery), config = recallConfigSchema.parse(rawConfig), spec = indexCollectionSchema.parse(rawSpec);
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    if (spec.ownerId !== ownerId || spec.embeddingVersion !== this.embedding.embeddingVersion || spec.dimensions !== this.embedding.dimensions
      || spec.provenance !== this.embedding.provenance) throw new RecallFailure('RECALL_CONFIGURATION_MISMATCH');
    const deadline = Math.min(Date.now() + config.totalTimeoutMs, options.deadline ?? Infinity);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new RecallFailure('DEADLINE_EXCEEDED');
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    const guard = () => { if (signal.aborted || Date.now() >= deadline) throw new RecallFailure(options.signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED'); };
    guard();
    const keywords = await this.keyword.recall(ownerId, query, { version: 'keyword-overlap-v1', limit: config.keywordLimit }); guard();
    let rankedKeywords = keywords.candidates.map(({ jobId, jobVersionId, rank }) => ({ jobId, jobVersionId, rank }));
    let rankedVectors: { jobId: string; jobVersionId: string; rank: number }[] = [];
    let reason: 'INDEX_NOT_READY' | 'VECTOR_UNAVAILABLE' | 'EMPTY_VECTOR_QUERY' | null = null;
    let phase: 'ready' | 'embedding' | 'vector' | 'database' = 'ready', reservationFailed = false;
    try {
      if (!query.summary.trim()) { reason = 'EMPTY_VECTOR_QUERY'; throw new RecallFailure(reason); }
      let ready;
      try { ready = await this.indexes.assertCorpusReady(ownerId, query.corpusVersion, spec); }
      catch (error) { if (error instanceof Error && error.message === 'INDEX_NOT_READY') reason = 'INDEX_NOT_READY'; throw error; }
      if (ready.corpus.contentHash !== keywords.corpusHash) throw new RecallFailure('CORPUS_HASH_MISMATCH');
      guard();
      phase = 'embedding';
      const embedded = await this.embedding.run([query.summary], { signal, deadline, ...(options.reserve ? { reserve: async (usage: EmbeddingReservation) => {
        try { await options.reserve!(usage); } catch (error) { reservationFailed = true; throw error; }
      } } : {}) }); guard();
      phase = 'vector';
      const points = await this.vector.query(spec, embedded.vectors[0], ready.corpus.manifest.members.map(member => member.jobVersionId), config.chunkLimit, { signal, deadline }); guard();
      phase = 'database';
      const versions = await this.indexes.visibleVersions(ownerId, [...new Set(points.map(point => point.payload.jobVersionId))], query.city); guard();
      const best = new Map<string, { jobId: string; jobVersionId: string; score: number }>();
      for (const point of points) {
        const version = versions.find(item => item.id === point.payload.jobVersionId);
        const member = ready.corpus.manifest.members.find(item => item.jobVersionId === point.payload.jobVersionId);
        if (!version || !member || version.contentHash !== member.contentHash || jdDocumentSchema.parse(version.document).textHash !== point.payload.contentHash) continue;
        const prior = best.get(version.id);
        if (!prior || point.score > prior.score) best.set(version.id, { jobId: version.jobId, jobVersionId: version.id, score: point.score });
      }
      const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
      rankedVectors = [...best.values()].sort((a, b) => b.score - a.score || compare(a.jobId, b.jobId) || compare(a.jobVersionId, b.jobVersionId))
        .slice(0, config.vectorLimit).map(({ jobId, jobVersionId }, index) => ({ jobId, jobVersionId, rank: index + 1 }));
    } catch (error) {
      guard();
      // Durable reservation failures must not be swallowed by vector degradation.
      if (!(error instanceof Error) || reservationFailed || phase === 'database' || (phase === 'ready' && reason === null)
        || (error instanceof EmbeddingFailure && ['BUDGET_EXHAUSTED', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNSETTLED'].includes(error.code))) throw error;
      reason ??= 'VECTOR_UNAVAILABLE';
      if (config.vectorFailure === 'error') throw new RecallFailure(reason, { cause: error });
    }
    guard();
    // External work may outlive a concurrent deletion. Recheck both paths, including keyword fallback.
    const valid = await this.indexes.validCandidates(ownerId, query.corpusVersion,
      [...new Set([...rankedKeywords, ...rankedVectors].map(item => item.jobVersionId))], query.city); guard();
    const retain = (items: typeof rankedKeywords) => items.filter(item => valid.some(row => row.jobVersionId === item.jobVersionId && row.jobId === item.jobId))
      .map((item, index) => ({ ...item, rank: index + 1 }));
    rankedKeywords = retain(rankedKeywords); rankedVectors = retain(rankedVectors);
    return recallResultSchema.parse({ schemaVersion: 1, corpusVersion: query.corpusVersion, corpusHash: keywords.corpusHash,
      config, embeddingVersion: spec.embeddingVersion, indexSpec: spec, candidates: fuseRecall(rankedKeywords, rankedVectors, config),
      degraded: reason !== null, degradationReason: reason });
  }
}
