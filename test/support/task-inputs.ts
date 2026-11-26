import { randomUUID } from 'node:crypto';
import { syntheticAnalysisInputSchema, syntheticJobIndexInputSchema } from '../../src/contracts/tasks.js';

const budget = {
  maxAttempts: 3, maxModelCalls: 0, maxTokens: 0,
  maxCostMicros: 0, currency: 'USD', maxDurationMs: 10_000,
};

export function analysisInput() {
  return syntheticAnalysisInputSchema.parse({
    schemaVersion: 1, kind: 'synthetic', budget,
    resumeVersionId: randomUUID(), jobCorpusVersionId: randomUUID(), asOfDate: '2026-11-25',
    rubricVersion: 'synthetic-v1', scoringVersion: 'synthetic-v1', promptVersion: 'synthetic-v1',
    modelConfigVersion: 'no-model-v1', embeddingVersion: 'no-embedding-v1',
  });
}

export function jobIndexInput() {
  return syntheticJobIndexInputSchema.parse({
    schemaVersion: 1, kind: 'synthetic', budget, visibility: 'private', jobVersionId: randomUUID(),
    contentHash: 'a'.repeat(64), requirementsHash: 'b'.repeat(64),
    embeddingVersion: 'no-embedding-v1', indexVersion: 'synthetic-v1',
    chunkerVersion: 'synthetic-v1', componentVersion: 'synthetic-v1',
  });
}
