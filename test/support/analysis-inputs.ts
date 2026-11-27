import { analysisConfigurationSchema } from '../../src/contracts/tasks.js';

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
