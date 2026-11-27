import { analysisConfigurationSchema } from '../../src/contracts/tasks.js';
import { realAnalysisInputSchema } from '../../src/contracts/tasks.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionClaim } from '../../src/infrastructure/consumer/contracts.js';
import type { z } from 'zod';

// Versions only: no real model/embedding invocation is enabled by this fixture.
export function analysisConfiguration() {
  return analysisConfigurationSchema.parse({ schemaVersion: 1, configurationVersion: 'test-analysis-v1',
    rubricVersion: 'rubric-v1', scoringVersion: 'scoring-v1', promptVersion: 'analysis-v1',
    modelConfigVersion: 'test-no-model-v1', embeddingVersion: 'test-no-embedding-v1',
    budget: { maxAttempts: 3, maxModelCalls: 10, maxTokens: 10000, maxCostMicros: 1000, currency: 'CNY', maxDurationMs: 600000 },
    maxJudgments: 400, recall: { version: 'hybrid-rrf-v1', vectorFailure: 'error' },
    indexTarget: { schemaVersion: 1, project: 'resume-studio', kind: 'job-index', embeddingVersion: 'test-no-embedding-v1',
      indexVersion: 'test-index-v1', dimensions: 1024, provenance: 'bailian', chunkerVersion: 'jd-chunks-v1', componentVersion: 'job-index-v1' },
  });
}

export function realAnalysisClaim(): ExecutionClaim & { snapshot: z.infer<typeof realAnalysisInputSchema> } {
  const ownerId = randomUUID(), taskId = randomUUID(), config = analysisConfiguration();
  return { ownerId, consumerName: 'analysis.worker.v1', message: { schemaVersion: 1, messageId: randomUUID(), taskType: 'analysis', taskId,
    dispatchGeneration: 1, occurredAt: new Date().toISOString() }, attemptId: randomUUID(), fenceToken: 1n,
    startedAt: new Date(), deadline: new Date(Date.now() + 5000), graph: { threadId: taskId, generation: 1 },
    snapshot: realAnalysisInputSchema.parse({ ...config, kind: 'analysis', ownerId, resumeVersionId: randomUUID(), asOfDate: '2026-11-27',
      jobCorpusVersionId: 'test-corpus-v1', configurationHash: 'a'.repeat(64), resumeFileHash: 'b'.repeat(64), corpusHash: 'c'.repeat(64), rubricHash: 'd'.repeat(64) }) };
}
