import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { syntheticRubric, jobDraft } from './support/job-inputs.js';
import { extractedDocument } from '../src/modules/resumes/evidence.js';
import { profileModelOutputSchema } from '../src/contracts/profile.js';
import { validateProfile } from '../src/modules/analysis/profile.service.js';
import { parsedResumeSchema } from '../src/contracts/parsed-resume.js';
import { validateMatchBatch, judgeThreshold } from '../src/modules/analysis/matching.js';
import { recallQueryFromResume } from '../src/modules/analysis/candidate.service.js';

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
await test('MATCH rejects missing/duplicate/unknown requirements and forged citations without dropping entries', () => {
  const { ownerId, document, ref } = fixture(), jobId = randomUUID();
  const judgment = { requirementId: 'r1', verdict: 'met', evidenceRefs: [ref], reason: '合成匹配' };
  assert.equal(validateMatchBatch(ownerId, document, jobId, ['r1'], { judgments: [judgment] })[0]?.method, 'model');
  for (const judgments of [[], [judgment, judgment], [{ ...judgment, requirementId: 'unknown' }], [{ ...judgment, totalScore: 100 }],
    [{ ...judgment, evidenceRefs: [{ ...ref, start: 999 }] }]]) assert.throws(() => validateMatchBatch(ownerId, document, jobId, ['r1'], { judgments }));
  assert.equal(validateMatchBatch(ownerId, document, jobId, ['r1'], { judgments: [{ ...judgment, verdict: 'unknown', evidenceRefs: [] }] })[0]?.verdict, 'unknown');
});
await test('explicit tenure threshold arithmetic uses frozen dates, unsupported metrics remain unknown and recall masks contacts', () => {
  const { ownerId, parsed } = fixture(), job = jobDraft(ownerId), requirement = job.requirements[0]!;
  const rule = (value: number, unit = 'employment_months') => ({ ...requirement, threshold: { operator: 'gte', value, unit } });
  assert.equal(judgeThreshold(job.id, rule(24), parsed, '2026-11-27')?.verdict, 'met');
  assert.equal(judgeThreshold(job.id, rule(25), parsed, '2026-11-27')?.verdict, 'unmet');
  assert.equal(judgeThreshold(job.id, rule(2,'employment_years'), parsed, '2026-11-27')?.verdict, 'met');
  assert.equal(judgeThreshold(job.id, rule(2,'years'), parsed, '2026-11-27')?.verdict, 'unknown');
  assert.equal(judgeThreshold(job.id, rule(24), { ...parsed, work: [] }, '2026-11-27')?.verdict, 'unknown');
  const query = recallQueryFromResume(parsed, 'corpus-v1'); assert.equal(query.corpusVersion, 'corpus-v1');
  assert.deepEqual(query.skills, ['TypeScript']); assert.doesNotMatch(query.summary, /example@example/);
});
