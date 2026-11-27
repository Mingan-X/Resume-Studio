import { z } from 'zod';
import { recallConfigSchema } from './recall.js';
import { indexCollectionSchema } from './job-index.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonnegative = z.int().nonnegative();
export const idempotencyKeySchema = uuid;
export const taskTypeSchema = z.enum(['analysis', 'job-index']);
export type TaskType = z.infer<typeof taskTypeSchema>;

// Limits are explicit frozen inputs; synthetic fixtures are not production defaults.
export const taskBudgetSchema = z.object({
  maxAttempts: z.int().positive(),
  maxModelCalls: nonnegative,
  maxTokens: nonnegative,
  maxCostMicros: nonnegative,
  currency: z.string().regex(/^[A-Z]{3}$/),
  maxDurationMs: z.int().positive(),
}).strict();

export const budgetUsageSchema = z.object({
  schemaVersion: z.literal(1), attempts: nonnegative, modelCalls: nonnegative,
  tokens: nonnegative, costMicros: nonnegative, elapsedMs: nonnegative,
}).strict();

const commonInput = {
  schemaVersion: z.literal(1),
  kind: z.literal('synthetic'),
  budget: taskBudgetSchema,
};
export const syntheticAnalysisInputSchema = z.object({
  ...commonInput,
  resumeVersionId: uuid,
  asOfDate: z.iso.date(),
  jobCorpusVersionId: uuid,
  rubricVersion: version,
  scoringVersion: version,
  promptVersion: version,
  modelConfigVersion: version,
  embeddingVersion: version,
}).strict();
export const syntheticJobIndexInputSchema = z.object({
  ...commonInput,
  visibility: z.literal('private'),
  jobVersionId: uuid,
  contentHash: hash,
  requirementsHash: hash,
  embeddingVersion: version,
  indexVersion: version,
  chunkerVersion: version,
  componentVersion: version,
}).strict();
// Safe server configuration only: connection URLs, credentials and model input are never persisted here.
export const analysisConfigurationSchema = z.object({
  schemaVersion: z.literal(1), configurationVersion: version,
  rubricVersion: version, scoringVersion: version, promptVersion: version, modelConfigVersion: version,
  embeddingVersion: version, budget: taskBudgetSchema,
  maxJudgments: z.int().min(1).max(400).default(400),
  recall: recallConfigSchema, indexTarget: indexCollectionSchema.omit({ ownerId: true }),
}).strict().refine(value => value.embeddingVersion === value.indexTarget.embeddingVersion, 'Embedding version mismatch');
export const realAnalysisInputSchema = z.object({
  ...analysisConfigurationSchema.shape, kind: z.literal('analysis'), ownerId: uuid,
  resumeVersionId: uuid, asOfDate: z.iso.date(), jobCorpusVersionId: version,
  configurationHash: hash, resumeFileHash: hash, corpusHash: hash, rubricHash: hash,
  scoringPolicyHash: hash.optional(), // Absent only on pre-S2.5 persisted tasks, which retain the original graph.
  reportVersion: z.literal(1).optional(), // Absent on historical tasks; only new tasks require report commit.
}).strict().refine(value => value.embeddingVersion === value.indexTarget.embeddingVersion, 'Embedding version mismatch');
export const analysisInputSnapshotSchema = z.discriminatedUnion('kind', [
  syntheticAnalysisInputSchema.extend({ ownerId: uuid }), realAnalysisInputSchema,
]);
export const realJobIndexInputSchema = syntheticJobIndexInputSchema.extend({ kind: z.literal('job-index') });
export const jobIndexInputSnapshotSchema = z.discriminatedUnion('kind', [
  syntheticJobIndexInputSchema.extend({ ownerId: uuid }), realJobIndexInputSchema.extend({ ownerId: uuid }),
]);
export type AnalysisInputSnapshot = z.infer<typeof analysisInputSnapshotSchema>;
export type JobIndexInputSnapshot = z.infer<typeof jobIndexInputSnapshotSchema>;

export const taskDispatchSchema = z.object({
  schemaVersion: z.literal(1),
  messageId: uuid,
  taskType: taskTypeSchema,
  taskId: uuid,
  dispatchGeneration: z.int().positive(),
  occurredAt: z.iso.datetime(),
}).strict();
export type TaskDispatch = z.infer<typeof taskDispatchSchema>;

export const taskFailureCodeSchema = z.enum(['UPSTREAM_TIMEOUT', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE',
  'UPSTREAM_5XX', 'INPUT_INVALID', 'UNSUPPORTED_INPUT', 'OUTPUT_INVALID', 'EXECUTION_FAILED',
  'BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED']);
export const quarantineCodeSchema = z.enum(['MALFORMED_MESSAGE', 'TASK_NOT_AVAILABLE', 'FUTURE_GENERATION', 'MESSAGE_ID_REUSED']);
export const deadMessageSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('dead'), messageId: uuid,
  taskType: taskTypeSchema, occurredAt: z.iso.datetime(),
  originalMessageId: uuid.nullable(), errorCode: z.union([taskFailureCodeSchema, quarantineCodeSchema]),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), taskId: uuid, dispatchGeneration: z.int().positive() }).strict(),
    z.object({ kind: z.literal('quarantine'), quarantineId: uuid, messageHash: hash }).strict(),
  ]),
}).strict();
export type DeadMessage = z.infer<typeof deadMessageSchema>;
export const outboundTaskMessageSchema = z.union([taskDispatchSchema, deadMessageSchema]);
export type OutboundTaskMessage = z.infer<typeof outboundTaskMessageSchema>;

export const usageReservationSchema = z.object({ modelCalls: nonnegative, tokens: nonnegative, costMicros: nonnegative }).strict();
export type UsageReservation = z.infer<typeof usageReservationSchema>;

export const taskCountsSchema = z.object({
  schemaVersion: z.literal(1), planned: nonnegative, completed: nonnegative, failed: nonnegative,
}).strict().refine(value => value.completed + value.failed <= value.planned);

// Malformed deliveries have no trusted owner/task. Store only bounded, safe metadata.
export const quarantineMetadataSchema = z.object({
  schemaVersion: z.literal(1), byteLength: nonnegative,
  source: z.enum(['analysis', 'job-index', 'unknown']),
}).strict();
