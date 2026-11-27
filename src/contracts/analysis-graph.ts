import { z } from 'zod';
import { sha256Schema } from './evidence.js';
import { versionNameSchema } from './jobs.js';
import { taskFailureCodeSchema } from './tasks.js';

export const analysisNodeSchema = z.enum(['LOAD', 'PARSE', 'EXTRACT', 'VALIDATE', 'PROFILE', 'RECALL', 'SNAP', 'MATCH', 'JOIN', 'FINALIZE']);
export type AnalysisNode = z.infer<typeof analysisNodeSchema>;
export const analysisNodeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), artifactId: z.uuid() }).strict(),
  z.object({ status: z.literal('failed'), code: taskFailureCodeSchema }).strict(),
]);
export type AnalysisNodeResult = z.infer<typeof analysisNodeResultSchema>;
export const analysisNodeIdentitySchema = z.object({ node: analysisNodeSchema, branchKey: z.string().min(1).max(512),
  inputHash: sha256Schema, componentVersion: versionNameSchema, schemaVersion: z.literal(1),
  promptVersion: versionNameSchema, modelConfigVersion: versionNameSchema,
}).strict();
export type AnalysisNodeIdentity = z.infer<typeof analysisNodeIdentitySchema>;
export const analysisNodeArtifactSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('analysis-node'),
  identity: analysisNodeIdentitySchema, result: analysisNodeResultSchema,
}).strict();
export const analysisGraphStateSchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), inputHash: sha256Schema,
  outputs: z.partialRecord(analysisNodeSchema, analysisNodeResultSchema),
}).strict();
export type AnalysisGraphState = z.infer<typeof analysisGraphStateSchema>;
