import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluationDatasetSchema, generateEvaluationDataset } from '../src/modules/evaluation/dataset.js';
import { requestHash } from '../src/modules/tasks/request-hash.js';

await test('S3.3 dataset freezes 20 synthetic resumes and 100 JDs without creating quality labels', () => {
  const dataset = generateEvaluationDataset();
  assert.equal(dataset.resumes.length, 20); assert.equal(dataset.jobs.length, 100);
  assert.equal(new Set(dataset.resumes.map(item => item.contentHash)).size, 20);
  assert.equal(requestHash(dataset), requestHash(generateEvaluationDataset()));
  assert.equal(dataset.annotationStatus, 'PENDING_HUMAN_REVIEW');
  assert.throws(() => evaluationDatasetSchema.parse({ ...dataset,
    resumes: dataset.resumes.map((item, index) => index ? item : { ...item, text: `${item.text}changed` }) }));
  assert.throws(() => evaluationDatasetSchema.parse({ ...dataset, annotations: [] }));
});
