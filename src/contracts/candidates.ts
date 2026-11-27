import { z } from 'zod';
import { recallQuerySchema, recallResultSchema } from './recall.js';
import { sha256Schema } from './evidence.js';

export const candidateSetContentSchema = z.object({ schemaVersion: z.literal(1), ownerId: z.uuid(), taskId: z.uuid(),
  query: recallQuerySchema, recall: recallResultSchema,
}).strict().refine(value => value.ownerId === value.recall.indexSpec.ownerId && value.query.corpusVersion === value.recall.corpusVersion);
export const candidateSetSchema = z.object({ id: z.uuid(), contentHash: sha256Schema, content: candidateSetContentSchema,
  createdAt: z.iso.datetime(),
}).strict();
export type CandidateSet = z.infer<typeof candidateSetSchema>;
