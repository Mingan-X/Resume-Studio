import { z } from 'zod';
import { rankingResultSchema, scoreResultSchema } from '../../contracts/scoring.js';
export function rankScores(raw: unknown) {
  const results = z.array(scoreResultSchema).max(20).parse(raw);
  if (new Set(results.map(item => item.jobVersionId)).size !== results.length) throw new Error('DUPLICATE_SCORED_JOB');
  results.sort((a, b) => (b.sortValue ?? -1) - (a.sortValue ?? -1) || (a.jobVersionId < b.jobVersionId ? -1 : a.jobVersionId > b.jobVersionId ? 1 : 0));
  const top10 = results.filter(item => item.eligibility === 'eligible' && item.sortValue !== null).slice(0, 10).map(item => item.jobVersionId);
  const pending = results.filter(item => item.eligibility === 'pending').map(item => item.jobVersionId), ineligible = results.filter(item => item.eligibility === 'ineligible').map(item => item.jobVersionId);
  const reasons: ('CANDIDATE_COUNT_BELOW_TEN'|'INELIGIBLE_CANDIDATES'|'PENDING_CANDIDATES')[] = [];
  if (top10.length < 10) { if (results.length < 10) reasons.push('CANDIDATE_COUNT_BELOW_TEN'); if (ineligible.length) reasons.push('INELIGIBLE_CANDIDATES'); if (pending.length) reasons.push('PENDING_CANDIDATES'); }
  return rankingResultSchema.parse({ schemaVersion: 1, results, top10, pending, ineligible, shortfall: { missing: 10 - top10.length, reasons } });
}
