import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { CandidateRepository } from '../../src/infrastructure/jobs/candidate.repository.js';
import { ResumeExtractionRepository } from '../../src/infrastructure/tasks/resume-extraction.repository.js';
import { MatchingRepository } from '../../src/infrastructure/tasks/matching.repository.js';
import { ScoringRepository } from '../../src/infrastructure/tasks/scoring.repository.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { scoreWeightsSchema } from '../../src/contracts/scoring.js';
import { budgetUsageSchema } from '../../src/contracts/tasks.js';
import { requestHash } from '../../src/modules/tasks/request-hash.js';
import { seedRealAnalysis, cleanRealAnalysis } from '../support/real-analysis.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';

await test('S2.5 real database recompute admits former 11th without model calls, isolates owners and rolls back partial writes', { timeout: 90000 }, async t => {
  await ownedPostgres(); const database = new DatabaseService(loadInfrastructureConfig(process.env)), db = database.client, ownerId = randomUUID();
  t.after(async () => { try { await ownedPostgres(); await cleanRealAnalysis(database, ownerId); } finally { await database.onModuleDestroy(); } });
  const fixture = await seedRealAnalysis(database, ownerId, { jobCount: 11, requirementCount: 2 });
  const store = new TaskExecutionStore(database, consumerConfigSchema.parse({}));
  const acquired = await store.claim(ownerId, fixture.message, 'analysis', fixture.snapshot.embeddingVersion, fixture.snapshot.modelConfigVersion);
  if (acquired.kind !== 'acquired') assert.fail(); const claim = acquired.claim;
  const parsed = { schemaVersion: 1, resumeVersionId: fixture.snapshot.resumeVersionId, education: [], work: [], projects: [], skills: [] };
  const extraction = await new ResumeExtractionRepository(database,database.pool).save(claim, requestHash(parsed), parsed);
  const jobRepository = new JobRepository(database), jobs = [];
  for (const draft of [...fixture.drafts].sort((a,b) => a.id < b.id ? -1 : 1)) {
    const job = await jobRepository.findVersion(ownerId,draft.id); assert.ok(job); jobs.push(job);
  }
  // Explicit synthetic recall fixture: this does not invoke or claim a real embedding result.
  const set = await new CandidateRepository(database).freeze(claim, { schemaVersion: 1, corpusVersion: fixture.snapshot.jobCorpusVersionId, skills: [], summary: '', city: null },
    { schemaVersion: 1, corpusVersion: fixture.snapshot.jobCorpusVersionId, corpusHash: fixture.snapshot.corpusHash,
      config: fixture.settings.recall, embeddingVersion: fixture.snapshot.embeddingVersion, indexSpec: { ...fixture.settings.indexTarget, ownerId },
      candidates: jobs.map((job,index) => ({ jobId: job.jobId, jobVersionId: job.id, rank: index+1, rrfScore: 1/(61+index), sources: [{ source: 'keyword', rank: index+1 }] })),
      degraded: true, degradationReason: 'INDEX_NOT_READY' });
  const matching = new MatchingRepository(database);
  const plan = await matching.prepare(claim, { schemaVersion: 1, taskId: fixture.taskId, candidateSetId: set.id, candidateSetHash: set.contentHash,
    extractionId: extraction.id, maxJudgments: 400, jobs,
    requirements: jobs.flatMap(job => job.requirements.map(item => ({ jobVersionId: job.id, requirementId: item.stableId }))).map((item,ordinal) => ({ ...item, ordinal, allocated: true })) });
  const block = fixture.document.blocks[0]!;
  for (const job of jobs) await matching.completeBatch(claim, plan.id, job.requirements.map((item,index) => ({ jobVersionId: job.id, requirementId: item.stableId,
    verdict: index === 0 ? 'met' : 'unmet', method: 'model', reason: '显式合成数据库fixture',
    evidenceRefs: [{ sourceType: 'RESUME', sourceVersionId: fixture.snapshot.resumeVersionId, blockId: block.id, start: 0, end: block.text.length, quote: block.text }] })));
  const scores = new ScoringRepository(database), first = await scores.score(claim), ranking = await scores.rank(claim,first.id);
  assert.equal(ranking.content.results.length,11); assert.equal(ranking.content.top10.length,10);
  assert.deepEqual(await scores.score(claim), first);
  await assert.rejects(scores.score({ ...claim, fenceToken: claim.fenceToken+1n }), /LEASE_LOST/);
  const last = jobs[10]!; assert.ok(!ranking.content.top10.includes(last.id));
  const override = [{ jobVersionId: last.id, weights: scoreWeightsSchema.parse({ dimensionWeights: first.content.policy.dimensionWeights,
    requirementWeights: last.requirements.map((item,index) => ({ requirementId: item.stableId, weight: index===0?99:1 })) }) }];
  await assert.rejects(scores.recompute(ownerId,first.id,override), /NOT_COMPLETE/);
  // Fixture terminal transition only; production completion is covered by analysis-runtime.test.
  await db.analysisTask.update({ where: { id: fixture.taskId }, data: { status: 'SUCCEEDED' } });
  const replays = await Promise.all([scores.recompute(ownerId,first.id,override), scores.recompute(ownerId,first.id,override)]);
  assert.equal(replays[0]?.score.id,replays[1]?.score.id); assert.equal(replays[0]?.ranking.content.top10[0],last.id);
  assert.equal(replays[0]?.score.content.judgmentSetHash,first.content.judgmentSetHash);
  assert.deepEqual((await db.scoreSet.findUniqueOrThrow({ where: { id:first.id } })).content,first.content);
  assert.deepEqual((await db.candidateSet.findUniqueOrThrow({ where: { id:set.id } })).content,set.content);
  assert.equal(budgetUsageSchema.parse((await db.analysisTask.findUniqueOrThrow({ where: { id:fixture.taskId } })).budgetUsage).modelCalls,0);
  await assert.rejects(scores.recompute(randomUUID(),first.id,override),/NOT_FOUND/);
  await assert.rejects(scores.recompute(ownerId,first.id,[{ ...override[0]!, jobVersionId:randomUUID() }]),/OVERRIDE_INVALID/);
  const before = await db.scoreSet.count({ where: { ownerId } });
  const broken: TransactionDatabase = { client: { $transaction: work => db.$transaction(tx => work(new Proxy(tx, {
    get(current, name, receiver) {
      if (name === 'rankingSnapshot') return new Proxy(current.rankingSnapshot, { get(model, method, receiver) {
        if (method === 'create') return () => { throw new Error('TEST_RANKING_INSERT_FAILED'); }; return Reflect.get(model,method,receiver);
      } });
      return Reflect.get(current,name,receiver);
    },
  }))) } };
  const different = [{ ...override[0]!, weights: { ...override[0]!.weights, requirementWeights: last.requirements.map((item,index) => ({ requirementId:item.stableId,weight:index===0?50:1 })) } }];
  await assert.rejects(new ScoringRepository(broken).recompute(ownerId,first.id,different),/TEST_RANKING_INSERT_FAILED/);
  assert.equal(await db.scoreSet.count({ where: { ownerId } }),before);
});
