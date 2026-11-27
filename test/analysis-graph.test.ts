import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mergeAnalysisOutputs } from '../src/modules/analysis/analysis-graph.js';
import { analysisGraphStateSchema } from '../src/contracts/analysis-graph.js';

await test('analysis graph merges stable node identities, preserves failures and refuses contradictory replay', () => {
  const profile = { status: 'ok' as const, artifactId: randomUUID() }, match = { status: 'failed' as const, code: 'OUTPUT_INVALID' as const };
  assert.deepEqual(mergeAnalysisOutputs({ PROFILE: profile }, { MATCH: match }), { PROFILE: profile, MATCH: match });
  assert.deepEqual(mergeAnalysisOutputs({ PROFILE: profile }, { PROFILE: profile }), { PROFILE: profile });
  assert.throws(() => mergeAnalysisOutputs({ PROFILE: profile }, { PROFILE: { ...profile, artifactId: randomUUID() } }), /BRANCH_CONFLICT/);
  const state = { schemaVersion: 1, taskId: randomUUID(), inputHash: 'a'.repeat(64), outputs: { PROFILE: profile, MATCH: match } };
  assert.equal(analysisGraphStateSchema.safeParse(state).success, true);
  assert.equal(analysisGraphStateSchema.safeParse({ ...state, rawResume: 'forbidden' }).success, false);
  assert.equal(analysisGraphStateSchema.safeParse({ ...state, outputs: { UNKNOWN_NODE: profile } }).success, false);
});
