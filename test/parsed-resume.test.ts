import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { extractedDocument } from '../src/modules/resumes/evidence.js';
import { validateParsedResume } from '../src/modules/resumes/parsed-resume.js';

await test('ParsedResume fixed synthetic contract uses null/empty arrays and verifies every source reference', () => {
  const owner = randomUUID(), version = randomUUID();
  const document = extractedDocument(version, 'a'.repeat(64), { parserVersion: 'synthetic-v1', warnings: [],
    blocks: [{ text: '示例大学\n项目甲：TypeScript\n项目乙：测试', location: { kind: 'DOCX', paragraph: 0, table: null } }] });
  const ref = { sourceType: 'RESUME', sourceVersionId: version, blockId: document.blocks[0]!.id, start: 0, end: 4, quote: '示例大学' };
  const empty = { schemaVersion: 1, resumeVersionId: version, education: [], work: [], projects: [], skills: [] };
  assert.deepEqual(validateParsedResume(owner, owner, document, empty), empty);
  const sample = { ...empty, education: [{ institution: '示例大学', degree: null, field: null, startDate: null, endDate: null, sourceRefs: [ref] }],
    projects: [
      { name: '项目甲', role: null, description: null, technologies: ['TypeScript'], sourceRefs: [ref] },
      { name: '项目乙', role: null, description: null, technologies: [], sourceRefs: [ref] },
    ] };
  // Derive offsets directly from the fixed synthetic source, never fabricate matching quotes.
  const text = document.blocks[0]!.text;
  sample.projects[0]!.sourceRefs = [{ ...ref, start: text.indexOf('项目甲'), end: text.indexOf('\n项目乙'), quote: '项目甲：TypeScript' }];
  sample.projects[1]!.sourceRefs = [{ ...ref, start: text.indexOf('项目乙'), end: text.length, quote: '项目乙：测试' }];
  assert.deepEqual(validateParsedResume(owner, owner, document, sample), sample);
  for (const invalid of [{ ...sample, totalScore: 100 }, { ...sample, resumeVersionId: randomUUID() },
    { ...sample, education: [{ ...sample.education[0], sourceRefs: [] }] },
    { ...sample, education: [{ ...sample.education[0], sourceRefs: [{ ...ref, quote: '伪造大学' }] }] },
    { ...sample, education: [{ ...sample.education[0], sourceRefs: [{ ...ref, sourceVersionId: randomUUID() }] }] },
    { ...sample, education: [{ ...sample.education[0], institution: undefined }] },
  ]) assert.throws(() => validateParsedResume(owner, owner, document, invalid));
  assert.throws(() => validateParsedResume(randomUUID(), owner, document, sample));
});
