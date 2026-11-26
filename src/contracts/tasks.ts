import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonnegative = z.int().nonnegative();
export const idempotencyKeySchema = uuid;
export const taskTypeSchema = z.enum(['analysis', 'job-index']);
export type TaskType = z.infer<typeof taskTypeSchema>;

// Synthetic values are explicit test inputs, not production limits or model choices.
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
export const analysisInputSnapshotSchema = syntheticAnalysisInputSchema.extend({ ownerId: uuid });
export const jobIndexInputSnapshotSchema = syntheticJobIndexInputSchema.extend({ ownerId: uuid });
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

export const taskCountsSchema = z.object({
  schemaVersion: z.literal(1), planned: nonnegative, completed: nonnegative, failed: nonnegative,
}).strict().refine(value => value.completed + value.failed <= value.planned);

// Malformed deliveries have no trusted owner/task. Store only bounded, safe metadata.
export const quarantineMetadataSchema = z.object({
  schemaVersion: z.literal(1), byteLength: nonnegative,
  source: z.enum(['analysis', 'job-index', 'unknown']),
}).strict();
