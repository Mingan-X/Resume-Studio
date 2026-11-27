import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSyntheticJobs } from '../src/modules/recall/synthetic-corpus.js';
import { normalizeSkills, skillDictionaryV1 } from '../src/modules/recall/skills.js';
import { validateJobRequirements } from '../src/modules/jobs/evidence.js';

await test('S2.3 dictionary canonicalizes exact aliases, deduplicates and retains unknown skills', () => {
  assert.deepEqual(normalizeSkills(['ＴＳ', ' TypeScript ', 'JS', 'Java', '未知技能', 'NodeJS']).skills,
    ['java', 'javascript', 'node.js', 'typescript', '未知技能']);
  assert.deepEqual(normalizeSkills(['Java']).skills, ['java']);
  const later = structuredClone(skillDictionaryV1);
  later.version = 'skills-zh-v2'; later.entries.push({ name: 'new-skill', aliases: ['未知技能'] });
  const frozen = normalizeSkills(['未知技能']);
  assert.deepEqual(normalizeSkills(['未知技能'], later).skills, ['new-skill']);
  assert.deepEqual(frozen, { dictionaryVersion: 'skills-zh-v1', skills: ['未知技能'] });
  later.entries.push({ name: 'ambiguous', aliases: ['TS'] });
  assert.throws(() => normalizeSkills([], later), /AMBIGUOUS_SKILL_ALIAS/);
});

await test('S2.3 100 synthetic JDs reproduce IDs, contents and valid Chinese source ranges', () => {
  const owner = '65aecdf8-1579-4c57-b2df-99962303a2e2', jobs = generateSyntheticJobs(owner);
  assert.deepEqual(generateSyntheticJobs(owner), jobs);
  assert.equal(jobs.length, 100); assert.equal(new Set(jobs.map(job => job.id)).size, 100);
  assert.equal(new Set(jobs.map(job => job.document.textHash)).size, 100);
  for (const job of jobs) {
    assert.match(job.document.blocks[0]!.text, /合成JD/);
    assert.equal(job.requirements.length, 6);
    validateJobRequirements(owner, owner, job.document, job.requirements);
  }
  assert.notEqual(generateSyntheticJobs('b4e39dd9-1240-4fce-ac84-5c934dd12a82')[0]!.id, jobs[0]!.id);
});
