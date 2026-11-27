import { z } from 'zod';
import { sha256Schema } from '../../contracts/evidence.js';
import { versionNameSchema } from '../../contracts/jobs.js';
import { requestHash } from '../tasks/request-hash.js';
import { evaluationDatasetSchema } from './dataset.js';

const id = z.string().min(1).max(128);
const verdicts = ['met', 'partial', 'unmet', 'unknown'] as const;
const verdict = z.enum(verdicts);
const pair = z.object({ jobVersionId: z.uuid(), requirementId: id });
const unique = <T>(items: T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
const pairKey = (item: z.infer<typeof pair>) => `${item.jobVersionId}/${item.requirementId}`;
const outputSchema = z.object({
  candidateJobVersionIds: z.array(z.uuid()).max(20),
  structured: z.array(z.object({ id, value: z.json() }).strict()).max(1000),
  citations: z.array(z.object({ id, start: z.int().nonnegative(), end: z.int().nonnegative(),
    quote: z.string().max(100_000) }).strict()).max(10_000),
  requirements: z.array(pair.extend({ verdict: verdict.nullable(), citationIds: z.array(id).max(100) }).strict()).max(10_000),
  rankedJobVersionIds: z.array(z.uuid()).max(300),
}).strict().refine(value => unique(value.candidateJobVersionIds, item => item) && unique(value.structured, item => item.id) && unique(value.citations, item => item.id) &&
  unique(value.requirements, pairKey) && unique(value.rankedJobVersionIds, item => item) &&
  value.requirements.every(item => unique(item.citationIds, item => item) &&
    (item.verdict !== null || item.citationIds.length === 0) && item.citationIds.every(citationId => value.citations.some(citation => citation.id === citationId))),
  'OUTPUT_IDENTITIES_INVALID');

export const qualityRunSchema = z.object({ schemaVersion: z.literal(1), runVersion: versionNameSchema,
  provenance: z.literal('REAL_MODEL_AND_EMBEDDING'), datasetHash: sha256Schema, performedAt: z.iso.datetime(),
  modelVersion: versionNameSchema, promptVersion: versionNameSchema, embeddingVersion: versionNameSchema,
  rubricVersion: versionNameSchema, scoringPolicyVersion: versionNameSchema, currency: z.enum(['CNY', 'USD']),
  results: z.array(z.object({ resumeId: id, resumeHash: sha256Schema, output: outputSchema,
    durationMs: z.number().finite().nonnegative(), inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(), costMicros: z.int().nonnegative().nullable(),
    degraded: z.literal(false),
  }).strict()).min(1).max(1000),
}).strict().refine(value => unique(value.results, item => item.resumeId), 'DUPLICATE_RESUME');

export const qualityAnnotationsSchema = z.object({ schemaVersion: z.literal(1), annotationVersion: versionNameSchema,
  provenance: z.literal('HUMAN_ANNOTATED'), datasetHash: sha256Schema,
  reviewedBy: id, reviewedAt: z.iso.datetime(),
  results: z.array(z.object({ resumeId: id, outputHash: sha256Schema,
    // expectedFieldIds include omissions; correctness only covers fields that actually exist.
    expectedFieldIds: z.array(id).min(1).max(1000),
    fields: z.array(z.object({ id, correct: z.boolean() }).strict()).max(1000),
    citations: z.array(z.object({ id, supported: z.boolean() }).strict()).max(10_000),
    requirements: z.array(pair.extend({ expected: verdict }).strict()).max(10_000),
    relevance: z.array(z.object({ jobVersionId: z.uuid(), relevant: z.boolean() }).strict()).min(100).max(300),
  }).strict()).min(1).max(1000),
}).strict().refine(value => unique(value.results, item => item.resumeId), 'DUPLICATE_RESUME');

function exactKeys(actual: string[], expected: string[]): void {
  if (!unique(actual, item => item) || actual.length !== expected.length || actual.some(item => !expected.includes(item))) {
    throw new Error('EVALUATION_ANNOTATIONS_INCOMPLETE');
  }
}
function rate(numerator: number, denominator: number) {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

export function evaluateQuality(rawDataset: unknown, rawRun: unknown, rawAnnotations: unknown, rawK: unknown) {
  const dataset = evaluationDatasetSchema.parse(rawDataset), run = qualityRunSchema.parse(rawRun);
  const annotations = qualityAnnotationsSchema.parse(rawAnnotations), k = z.int().min(1).max(300).parse(rawK);
  const datasetHash = requestHash(dataset);
  if (run.datasetHash !== datasetHash || annotations.datasetHash !== datasetHash) throw new Error('EVALUATION_HASH_MISMATCH');
  exactKeys(run.results.map(item => item.resumeId), dataset.resumes.map(item => item.id));
  exactKeys(annotations.results.map(item => item.resumeId), dataset.resumes.map(item => item.id));
  const jobIds = dataset.jobs.map(item => item.id);
  const allowedPairs = new Set(dataset.jobs.flatMap(job => job.requirements.map(requirement => pairKey({ jobVersionId: job.id, requirementId: requirement.stableId }))));
  const matrix = Object.fromEntries(verdicts.map(expected => [expected, Object.fromEntries(verdicts.map(predicted => [predicted, 0]))]));
  let citationCount = 0, located = 0, supported = 0, fieldCount = 0, correctFields = 0, expectedFields = 0, presentFields = 0;
  let planned = 0, judged = 0, correct = 0, unknownPredicted = 0, unknownExpected = 0, unknownCorrect = 0;
  const queries = dataset.resumes.map(resume => {
    const result = run.results.find(item => item.resumeId === resume.id)!;
    const annotation = annotations.results.find(item => item.resumeId === resume.id)!;
    if (result.resumeHash !== resume.contentHash || annotation.outputHash !== requestHash(result.output)) throw new Error('EVALUATION_HASH_MISMATCH');
    const output = result.output;
    if (output.candidateJobVersionIds.some(item => !jobIds.includes(item))) throw new Error('EVALUATION_INPUT_MISMATCH');
    exactKeys(output.requirements.map(pairKey), dataset.jobs.filter(job => output.candidateJobVersionIds.includes(job.id))
      .flatMap(job => job.requirements.map(requirement => pairKey({ jobVersionId: job.id, requirementId: requirement.stableId }))));
    exactKeys(annotation.fields.map(item => item.id), output.structured.map(item => item.id));
    exactKeys(annotation.citations.map(item => item.id), output.citations.map(item => item.id));
    exactKeys(annotation.requirements.map(pairKey), output.requirements.filter(item => item.verdict !== null).map(pairKey));
    exactKeys(annotation.relevance.map(item => item.jobVersionId), jobIds);
    if (!unique(annotation.expectedFieldIds, item => item) || output.rankedJobVersionIds.some(item => !jobIds.includes(item)) ||
        output.requirements.some(item => !allowedPairs.has(pairKey(item)))) throw new Error('EVALUATION_INPUT_MISMATCH');
    expectedFields += annotation.expectedFieldIds.length;
    presentFields += annotation.expectedFieldIds.filter(field => output.structured.some(item => item.id === field)).length;
    fieldCount += output.structured.length; correctFields += annotation.fields.filter(item => item.correct).length;
    for (const citation of output.citations) {
      citationCount++;
      // A half surrogate must never count as a valid character boundary.
      const boundary = (offset: number) => !(offset > 0 && offset < resume.text.length &&
        /[\uD800-\uDBFF]/u.test(resume.text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(resume.text[offset]!));
      const valid = citation.end > citation.start && citation.end <= resume.text.length && boundary(citation.start) && boundary(citation.end) &&
        citation.quote === resume.text.slice(citation.start, citation.end);
      if (valid) located++;
      if (valid && annotation.citations.find(item => item.id === citation.id)!.supported) supported++;
    }
    planned += output.requirements.length;
    for (const item of output.requirements) {
      if (item.verdict === null) continue;
      const expected = annotation.requirements.find(label => pairKey(label) === pairKey(item))!.expected;
      judged++; matrix[expected]![item.verdict]!++;
      if (item.verdict === expected) correct++;
      if (item.verdict === 'unknown') unknownPredicted++;
      if (expected === 'unknown') unknownExpected++;
      if (expected === 'unknown' && item.verdict === 'unknown') unknownCorrect++;
    }
    const relevant = new Set(annotation.relevance.filter(item => item.relevant).map(item => item.jobVersionId));
    const hits = output.rankedJobVersionIds.slice(0, k).filter(item => relevant.has(item)).length;
    return { resumeId: resume.id, ...rate(hits, relevant.size) };
  });
  const evaluable = queries.filter(item => item.rate !== null);
  const costKnown = run.results.filter(item => item.costMicros !== null);
  const tokensKnown = run.results.filter(item => item.inputTokens !== null && item.outputTokens !== null);
  return { schemaVersion: 1, datasetHash, runHash: requestHash(run), annotationHash: requestHash(annotations),
    runVersion: run.runVersion, annotationVersion: annotations.annotationVersion, sampleCount: run.results.length,
    citationLocationValidity: rate(located, citationCount), citationSupportedValidity: rate(supported, citationCount),
    structuredCorrectness: rate(correctFields, fieldCount), structuredCoverage: rate(presentFields, expectedFields),
    requirementAccuracy: rate(correct, judged), requirementCoverage: rate(judged, planned), unexecutedRequirements: planned - judged,
    unknownPrecision: rate(unknownCorrect, unknownPredicted), unknownRecall: rate(unknownCorrect, unknownExpected), confusionMatrix: matrix,
    recall: { k, queries, macro: evaluable.length ? evaluable.reduce((sum, item) => sum + item.rate!, 0) / evaluable.length : null,
      micro: rate(queries.reduce((sum, item) => sum + item.numerator, 0), queries.reduce((sum, item) => sum + item.denominator, 0)),
      excludedNoRelevant: queries.length - evaluable.length },
    usage: { currency: run.currency, costKnownSamples: costKnown.length, costUnknownSamples: run.results.length - costKnown.length,
      knownCostMicros: costKnown.reduce((sum, item) => sum + item.costMicros!, 0),
      totalCostMicros: costKnown.length === run.results.length ? costKnown.reduce((sum, item) => sum + item.costMicros!, 0) : null,
      tokenKnownSamples: tokensKnown.length, totalTokens: tokensKnown.length === run.results.length ?
        tokensKnown.reduce((sum, item) => sum + item.inputTokens! + item.outputTokens!, 0) : null,
      durationMs: { min: Math.min(...run.results.map(item => item.durationMs)), max: Math.max(...run.results.map(item => item.durationMs)),
        mean: run.results.reduce((sum, item) => sum + item.durationMs, 0) / run.results.length } },
    releaseThreshold: null,
  };
}
