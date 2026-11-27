import type { DatabaseService } from '../database/database.service.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import type { CheckpointConfig } from '../checkpoint/config.js';
import type { ModelExecutor } from '../../modules/models/model-executor.js';
import type { EmbeddingExecutor } from '../../modules/embeddings/embedding-executor.js';
import type { JobIndexVector } from '../vector/job-index.vector.js';
import type { ObservabilityService } from '../observability/observability.module.js';
import { AnalysisModelCaller } from '../../modules/analysis/model-caller.js';
import { ResumeRepository } from '../storage/resume.repository.js';
import { JobRepository } from '../jobs/job.repository.js';
import { ResumeExtractionRepository } from './resume-extraction.repository.js';
import { ResumeExtractionService } from '../../modules/analysis/extraction.service.js';
import { ProfileRepository } from './profile.repository.js';
import { ProfileService } from '../../modules/analysis/profile.service.js';
import { CandidateRepository } from '../jobs/candidate.repository.js';
import { RecallFailure, RecallService } from '../../modules/recall/recall.service.js';
import { KeywordRecallRepository } from '../jobs/keyword-recall.repository.js';
import { JobIndexRepository } from '../jobs/index.repository.js';
import { AnalysisCandidateService } from '../../modules/analysis/candidate.service.js';
import { MatchingRepository } from './matching.repository.js';
import { MatchingService } from '../../modules/analysis/matching.service.js';
import { AnalysisSummaryRepository } from './analysis-summary.repository.js';
import { AnalysisArtifactRepository, requireAnalysisAuthority } from './analysis-artifact.repository.js';
import { AnalysisGraph } from '../../modules/analysis/analysis-graph.js';
import type { AnalysisGraphNodes } from '../../modules/analysis/analysis-graph.js';
import type { AnalysisGraphState, AnalysisNodeResult } from '../../contracts/analysis-graph.js';
import { analysisNodeResultSchema } from '../../contracts/analysis-graph.js';
import { parsedResumeSchema } from '../../contracts/parsed-resume.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import { analysisCompletionSchema } from '../../contracts/analysis-summary.js';
import { TaskFailure } from '../consumer/failure.js';
import { TaskExecutionStore } from '../consumer/task-execution.store.js';
import { TaskDeliveryHandler } from '../consumer/task-delivery.handler.js';
import type { TaskHandler } from '../consumer/task-delivery.handler.js';
import { consumerConfigSchema } from '../consumer/config.js';
import { PostgresExecutionLock } from '../consumer/task-execution.lock.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { validateParsedResume } from '../../modules/resumes/parsed-resume.js';
import { normalizeEmployment } from '../../modules/analysis/dates.js';
import { JobCorpusRepository } from '../jobs/corpus.repository.js';
import { ScoringRepository } from './scoring.repository.js';
import { ScoringPolicyRepository } from './scoring-policy.repository.js';

export function createAnalysisRuntime(database: DatabaseService, identity: IdentityPort, checkpoint: CheckpointConfig,
  model: ModelExecutor, embedding: EmbeddingExecutor, vector: JobIndexVector,
  options: { allowSynthetic?: boolean; observation?: Pick<ObservabilityService, 'run'> } = {}) {
  if (embedding.provenance === 'synthetic' && options.allowSynthetic !== true) throw new Error('OFFICIAL_EMBEDDING_REQUIRED');
  const caller = new AnalysisModelCaller(model, options.observation), resumes = new ResumeRepository(database), jobs = new JobRepository(database);
  const extractionRepository = new ResumeExtractionRepository(database, database.pool), extractionService = new ResumeExtractionService(resumes, extractionRepository, caller);
  const profiles = new ProfileRepository(database), profileService = new ProfileService(resumes, jobs, profiles, caller);
  const candidates = new CandidateRepository(database), recall = new RecallService(identity, new KeywordRecallRepository(database), new JobIndexRepository(database), embedding, vector);
  const candidateService = new AnalysisCandidateService(candidates, recall), matching = new MatchingRepository(database);
  const matchingService = new MatchingService(candidates, jobs, resumes, matching, caller), summaries = new AnalysisSummaryRepository(database);
  const artifactRepository = new AnalysisArtifactRepository(database);
  const scores = new ScoringRepository(database);
  const extraction = async (state: AnalysisGraphState, claim: ExecutionClaim) => {
    const result = analysisNodeResultSchema.parse(state.outputs.EXTRACT);
    if (result.status !== 'ok') throw new TaskFailure('INPUT_INVALID');
    return database.client.$transaction(async tx => {
      const input = await requireAnalysisAuthority(tx, claim);
      const row = await tx.resumeExtraction.findFirst({ where: { ownerId: claim.ownerId, id: result.artifactId,
        resumeVersionId: input.resumeVersionId, promptVersion: input.promptVersion, modelConfigVersion: input.modelConfigVersion, schemaVersion: 1 } });
      if (!row) throw new TaskFailure('INPUT_INVALID'); const content = parsedResumeSchema.parse(row.content);
      if (requestHash(content) !== row.contentHash) throw new TaskFailure('INPUT_INVALID'); return { id: row.id, content };
    });
  };
  const safeSection = async (run: () => Promise<AnalysisNodeResult>): Promise<AnalysisNodeResult> => {
    try { return await run(); } catch (error) {
      if (error instanceof TaskFailure && !['INPUT_INVALID','DEADLINE_EXCEEDED'].includes(error.code)) return { status: 'failed', code: error.code };
      if (error instanceof RecallFailure && ['INDEX_NOT_READY','VECTOR_UNAVAILABLE','EMPTY_VECTOR_QUERY'].includes(error.message)) return { status: 'failed', code: 'DEPENDENCY_UNAVAILABLE' };
      throw error;
    }
  };
  const nodes: AnalysisGraphNodes = {
    LOAD: async (_state, { claim }) => {
      const input = realAnalysisInputSchema.parse(claim.snapshot), corpus = await new JobCorpusRepository(database).load(claim.ownerId, input.jobCorpusVersionId);
      const rubric = await jobs.findRubric(claim.ownerId, input.rubricVersion);
      if (!corpus || corpus.contentHash !== input.corpusHash || !rubric || rubric.contentHash !== input.rubricHash
        || input.promptVersion !== 'analysis-v1' || input.embeddingVersion !== embedding.embeddingVersion
        || input.indexTarget.dimensions !== embedding.dimensions || input.indexTarget.provenance !== embedding.provenance) throw new TaskFailure('INPUT_INVALID');
      if (input.scoringPolicyHash) {
        const policy = await new ScoringPolicyRepository(database).load(claim.ownerId, input.scoringVersion);
        if (!policy || policy.contentHash !== input.scoringPolicyHash) throw new TaskFailure('INPUT_INVALID');
      }
      return { status: 'ok', artifactId: claim.message.taskId };
    },
    PARSE: async (_state, { claim }) => {
      const input = realAnalysisInputSchema.parse(claim.snapshot), document = await resumes.document(claim.ownerId, input.resumeVersionId);
      if (!document || document.fileHash !== input.resumeFileHash) throw new TaskFailure('INPUT_INVALID');
      return { status: 'ok', artifactId: input.resumeVersionId };
    },
    EXTRACT: async (_state, { claim, budget, signal }) => ({ status: 'ok', artifactId: (await extractionService.extract(claim, budget, signal)).id }),
    VALIDATE: async (state, { claim }) => {
      const value = await extraction(state, claim), input = realAnalysisInputSchema.parse(claim.snapshot), document = await resumes.document(claim.ownerId, input.resumeVersionId);
      validateParsedResume(claim.ownerId, input.ownerId, document, value.content); normalizeEmployment(value.content, input.asOfDate);
      return { status: 'ok', artifactId: value.id };
    },
    PROFILE: async (state, { claim, budget, signal }) => safeSection(async () => ({ status: 'ok', artifactId: (await profileService.assess(claim, await extraction(state, claim), budget, signal)).id })),
    RECALL: async (state, { claim, budget, signal }) => safeSection(async () => ({ status: 'ok', artifactId: (await candidateService.freeze(claim, (await extraction(state, claim)).content, budget, signal)).id })),
    SNAP: async (state, { claim, budget, signal }) => {
      const result = analysisNodeResultSchema.parse(state.outputs.RECALL); if (result.status === 'failed') return result;
      const set = await candidateService.freeze(claim, (await extraction(state, claim)).content, budget, signal);
      if (set.id !== result.artifactId) throw new TaskFailure('INPUT_INVALID'); return { status: 'ok', artifactId: set.id };
    },
    MATCH: async (state, { claim, budget, signal }) => {
      const result = analysisNodeResultSchema.parse(state.outputs.SNAP); if (result.status === 'failed') return result;
      return safeSection(async () => ({ status: 'ok', artifactId: (await matchingService.match(claim, await extraction(state, claim), budget, signal)).id }));
    },
    SCORE: async (state, { claim }) => {
      const match = analysisNodeResultSchema.parse(state.outputs.MATCH); if (match.status === 'failed') return match;
      return { status: 'ok', artifactId: (await scores.score(claim)).id };
    },
    RANK: async (state, { claim }) => {
      const score = analysisNodeResultSchema.parse(state.outputs.SCORE); if (score.status === 'failed') return score;
      return { status: 'ok', artifactId: (await scores.rank(claim, score.artifactId)).id };
    },
    JOIN: async (state, { claim }) => {
      const profile = analysisNodeResultSchema.parse(state.outputs.PROFILE), match = analysisNodeResultSchema.parse(
        realAnalysisInputSchema.parse(claim.snapshot).scoringPolicyHash ? state.outputs.RANK : state.outputs.MATCH);
      const summary = await summaries.prepare(claim, { profileError: profile.status === 'failed' ? profile.code : null,
        matchingError: match.status === 'failed' ? match.code : null }); return { status: 'ok', artifactId: summary.id };
    },
    FINALIZE: async state => analysisNodeResultSchema.parse(state.outputs.JOIN),
  };
  for (const name of Object.keys(nodes) as (keyof AnalysisGraphNodes)[]) {
    const work = nodes[name]; nodes[name] = async (state, context) => {
      await summaries.progress(context.claim, name, { schemaVersion: 1, planned: 0, completed: 0, failed: 0 });
      const result = await work(state, context);
      if (name === 'MATCH' && result.status === 'ok') {
        const plan = await matching.load(context.claim); if (!plan) throw new TaskFailure('OUTPUT_INVALID');
        const completeJobs = plan.content.jobs.filter(job => plan.executions.filter(item => item.jobVersionId === job.id).every(item => item.status === 'DONE')).length;
        await summaries.progress(context.claim, 'MATCH', { schemaVersion: 1, planned: plan.content.jobs.length, completed: completeJobs, failed: 0 });
      }
      return result;
    };
  }
  const graph = new AnalysisGraph(checkpoint, artifactRepository, nodes), config = consumerConfigSchema.parse({}), store = new TaskExecutionStore(database, config);
  const handler: TaskHandler = { capability: 'analysis', embeddingVersion: embedding.embeddingVersion, modelConfigVersion: model.modelConfigVersion,
    execute: async (claim, signal, budget) => {
      const state = await graph.execute(claim, signal, budget), result = analysisNodeResultSchema.parse(state.outputs.FINALIZE);
      if (result.status !== 'ok') throw new TaskFailure('OUTPUT_INVALID');
      return analysisCompletionSchema.parse({ schemaVersion: 1, kind: 'analysis', inputHash: requestHash(claim.snapshot), summaryId: result.artifactId });
    },
  };
  return { graph, nodes, store, handler, delivery: new TaskDeliveryHandler(store, identity, handler, config, new PostgresExecutionLock(database.pool)) };
}
