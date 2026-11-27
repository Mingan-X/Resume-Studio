import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keywordRecallConfigSchema, recallQuerySchema } from '../src/contracts/recall.js';

await test('S2.3 keyword recall requires versioned corpus, caps limits and does not infer missing filters', () => {
  const query = recallQuerySchema.parse({ schemaVersion: 1, corpusVersion: 'synthetic-jd-zh-v1', skills: [], summary: '' });
  assert.equal(query.city, null);
  assert.equal(keywordRecallConfigSchema.parse({ version: 'keyword-overlap-v1' }).limit, 50);
  for (const limit of [0, 101, NaN, Infinity]) assert.equal(keywordRecallConfigSchema.safeParse({ version: 'keyword-overlap-v1', limit }).success, false);
  assert.equal(recallQuerySchema.safeParse({ ...query, years: 0 }).success, false);
  assert.equal(recallQuerySchema.safeParse({ ...query, ownerId: 'caller-owner' }).success, false);
});
