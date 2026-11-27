import { z } from 'zod';
import { versionNameSchema } from '../../contracts/jobs.js';
import { sha256Schema } from '../../contracts/evidence.js';

const ids = z.array(z.uuid()).max(10_000).refine(value => new Set(value).size === value.length, '版本ID不能重复');
export const relevanceAnnotationsSchema = z.object({ schemaVersion: z.literal(1), annotationVersion: versionNameSchema,
  provenance: z.literal('HUMAN_ANNOTATED'), reviewedBy: z.string().trim().min(1).max(128), reviewedAt: z.iso.datetime(),
  corpusHash: sha256Schema, corpusJobVersionIds: ids.min(1),
  queries: z.array(z.object({ queryId: versionNameSchema, queryHash: sha256Schema,
    judgments: z.array(z.object({ jobVersionId: z.uuid(), relevant: z.boolean() }).strict()).min(1).max(10_000),
  }).strict()).min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  const queries = new Set<string>(), corpus = new Set(value.corpusJobVersionIds);
  for (const [index, query] of value.queries.entries()) {
    const judged = query.judgments.map(item => item.jobVersionId);
    if (queries.has(query.queryId) || judged.length !== corpus.size || new Set(judged).size !== judged.length || judged.some(id => !corpus.has(id))) {
      ctx.addIssue({ code: 'custom', path: ['queries', index], message: '查询必须唯一且对冻结语料完整标注' });
    }
    queries.add(query.queryId);
  }
});
export const recallEvaluationRunSchema = z.object({ schemaVersion: z.literal(1), runVersion: versionNameSchema,
  provenance: z.literal('BAILIAN_REAL'), embeddingVersion: versionNameSchema, corpusHash: sha256Schema,
  performedAt: z.iso.datetime(), queries: z.array(z.object({ queryId: versionNameSchema, queryHash: sha256Schema,
    degraded: z.literal(false), rankedJobVersionIds: ids,
  }).strict()).min(1).max(1000),
}).strict().refine(value => new Set(value.queries.map(query => query.queryId)).size === value.queries.length);

export function evaluateRecall(rawAnnotations: unknown, rawRun: unknown, rawK: unknown) {
  const annotations = relevanceAnnotationsSchema.parse(rawAnnotations), run = recallEvaluationRunSchema.parse(rawRun);
  const k = z.int().min(1).max(1000).parse(rawK);
  if (run.corpusHash !== annotations.corpusHash || run.queries.length !== annotations.queries.length) throw new Error('EVALUATION_INPUT_MISMATCH');
  const corpus = new Set(annotations.corpusJobVersionIds);
  const queries = annotations.queries.map(annotation => {
    const result = run.queries.find(query => query.queryId === annotation.queryId);
    if (!result || result.queryHash !== annotation.queryHash || result.rankedJobVersionIds.some(id => !corpus.has(id))) throw new Error('EVALUATION_INPUT_MISMATCH');
    const relevant = new Set(annotation.judgments.filter(item => item.relevant).map(item => item.jobVersionId));
    const hits = result.rankedJobVersionIds.slice(0, k).filter(id => relevant.has(id)).length;
    return { queryId: annotation.queryId, relevant: relevant.size, retrieved: Math.min(k, result.rankedJobVersionIds.length),
      hits, recall: relevant.size ? hits / relevant.size : null };
  });
  const evaluable = queries.filter(query => query.recall !== null);
  const positives = queries.reduce((sum, query) => sum + query.relevant, 0), hits = queries.reduce((sum, query) => sum + query.hits, 0);
  return { schemaVersion: 1, annotationVersion: annotations.annotationVersion, runVersion: run.runVersion,
    embeddingVersion: run.embeddingVersion, corpusHash: run.corpusHash, k, queries,
    macroRecall: evaluable.length ? evaluable.reduce((sum, query) => sum + query.recall!, 0) / evaluable.length : null,
    microRecall: positives ? hits / positives : null, excludedNoRelevant: queries.length - evaluable.length };
}
