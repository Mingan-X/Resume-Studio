import { z } from 'zod';
import { recallCandidateSchema, recallConfigSchema } from '../../contracts/recall.js';

const rankedSchema = z.array(z.object({ jobId: z.uuid(), jobVersionId: z.uuid(), rank: z.int().positive() }).strict()).max(100);
export function fuseRecall(keyword: unknown, vector: unknown, rawConfig: unknown) {
  const config = recallConfigSchema.parse(rawConfig);
  const merged = new Map<string, z.infer<typeof recallCandidateSchema>>();
  for (const [source, input] of [['keyword', keyword], ['vector', vector]] as const) {
    const rows = rankedSchema.parse(input), seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.jobVersionId) || row.rank !== index + 1) throw new Error('INVALID_RECALL_RANKS');
      seen.add(row.jobVersionId);
      const prior = merged.get(row.jobVersionId);
      if (prior && prior.jobId !== row.jobId) throw new Error('RECALL_IDENTITY_MISMATCH');
      const item = prior ?? { jobId: row.jobId, jobVersionId: row.jobVersionId, rank: 1, rrfScore: 0, sources: [] };
      item.rrfScore += 1 / (config.rrfK + row.rank); item.sources.push({ source, rank: row.rank });
      merged.set(row.jobVersionId, item);
    });
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore || compare(a.jobId, b.jobId) || compare(a.jobVersionId, b.jobVersionId))
    .slice(0, config.limit).map((row, index) => recallCandidateSchema.parse({ ...row, rank: index + 1 }));
}
