import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { syntheticRubric } from './support/job-inputs.js';
import { extractedDocument } from '../src/modules/resumes/evidence.js';
import { profileModelOutputSchema } from '../src/contracts/profile.js';
import { validateProfile } from '../src/modules/analysis/profile.service.js';
import { parsedResumeSchema } from '../src/contracts/parsed-resume.js';

function fixture() {
  const ownerId = randomUUID(), rubric = syntheticRubric(), document = extractedDocument(randomUUID(), 'a'.repeat(64), {
    parserVersion: 'test-v1', warnings: [], blocks: [{ text: '2020-01至2022-01参与TypeScript开发。联系 example@example.test', location: { kind: 'PDF', page: 1, bounds: null } }] });
  const ref = { sourceType: 'RESUME', sourceVersionId: document.sourceVersionId, blockId: document.blocks[0]!.id, start: 0, end: 15, quote: '2020-01至2022-01' };
  const parsed = parsedResumeSchema.parse({ schemaVersion: 1, resumeVersionId: document.sourceVersionId, education: [], projects: [],
    work: [{ employer: null, role: null, startDate: '2020-01', endDate: '2022-01', ongoing: false, responsibilities: ['TypeScript开发。联系 example@example.test'], sourceRefs: [ref] }],
    skills: [{ name: 'TypeScript', context: null, sourceRefs: [ref] }] });
  const judgments = rubric.dimensions.map(item => ({ dimension: item.dimension, status: 'assessed', level: 2, featureIds: [item.levels[1]!.features[0]!.featureId],
    evidenceRefs: [ref], rubricRefs: [{ rubricVersion: rubric.version, dimension: item.dimension, level: 2, featureId: item.levels[1]!.features[0]!.featureId }], reason: '合成证据' }));
  return { ownerId, rubric, document, ref, parsed, judgments };
}
await test('PROFILE requires all six dimensions, exact evidence, valid level/features and no model scores', () => {
  const { ownerId, rubric, document, judgments } = fixture();
  assert.equal(validateProfile(ownerId, document, rubric, { judgments }).judgments.length, 6);
  assert.equal(profileModelOutputSchema.safeParse({ judgments: judgments.slice(1) }).success, false);
  assert.equal(profileModelOutputSchema.safeParse({ judgments: judgments.map(item => ({ ...item, score: 100 })) }).success, false);
  assert.throws(() => validateProfile(ownerId, document, rubric, { judgments: judgments.map(item => ({ ...item, featureIds: ['forged'] })) }));
  assert.throws(() => validateProfile(ownerId, document, rubric, { judgments: judgments.map(item => ({ ...item, evidenceRefs: [{ ...item.evidenceRefs[0], sourceVersionId: randomUUID() }] })) }));
  const unknown = judgments.map(item => ({ ...item, status: 'unknown', level: null, featureIds: [], rubricRefs: [], evidenceRefs: [], reason: '缺少证据' }));
  assert.equal(validateProfile(ownerId, document, rubric, { judgments: unknown }).judgments.every(item => item.level === null), true);
  assert.equal(profileModelOutputSchema.safeParse({ judgments: unknown.map(item => ({ ...item, level: 1 })) }).success, false);
});
