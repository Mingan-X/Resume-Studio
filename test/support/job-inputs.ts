import { randomUUID } from 'node:crypto';
import { dimensionIds, jobVersionSchema } from '../../src/contracts/jobs.js';
import { rubricVersionSchema } from '../../src/contracts/rubric.js';
import { jdDocument } from '../../src/modules/jobs/evidence.js';

export function jobDraft(ownerId: string) {
  const id = randomUUID(), document = jdDocument(id, '合成岗位：工程实践与自动化测试。');
  return jobVersionSchema.parse({ schemaVersion: 1, id, ownerId, jobId: randomUUID(), version: 1,
    title: '合成工程师', city: null, level: null, skills: ['TypeScript'], document,
    requirements: [{ stableId: 'engineering-tests', dimension: 'engineering', kind: 'SOFT', description: '自动化测试',
      threshold: null, weight: 1, priority: 0, sourceRef: { sourceType: 'JD', sourceVersionId: id,
        blockId: document.blocks[0]!.id, start: 10, end: 15, quote: '自动化测试' } }],
    dimensionWeights: dimensionIds.map(dimension => ({ dimension, weight: 1 })),
    hardRequirementsConfirmed: false, weightsConfirmed: false, status: 'DRAFT',
    contentHash: null, publishedAt: null, indexStatus: 'NOT_REQUESTED', createdAt: new Date().toISOString(),
  });
}
export function syntheticRubric(version = `test-${randomUUID()}`) {
  return rubricVersionSchema.parse({ schemaVersion: 1, version, provenance: 'SYNTHETIC', reviewStatus: 'TEST_ONLY',
    dimensions: dimensionIds.map(dimension => ({ dimension, levels: [1, 2, 3, 4, 5].map(level => ({
      level, score: level * 20, behavior: '测试用合成行为，不用于正式判断', evidenceThreshold: '测试用合成证据门槛',
      features: [{ featureId: `${dimension}-${level}`, description: '合成特征' }],
    })) })),
  });
}
