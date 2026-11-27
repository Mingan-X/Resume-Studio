import { z } from 'zod';
import { sha256Schema } from './evidence.js';
import { versionNameSchema } from './jobs.js';

export const skillDictionarySchema = z.object({ schemaVersion: z.literal(1), version: versionNameSchema,
  entries: z.array(z.object({ name: z.string().min(1).max(128), aliases: z.array(z.string().min(1).max(128)).max(50) }).strict()).min(1).max(1000),
}).strict();
export const corpusMemberSchema = z.object({ jobVersionId: z.uuid(), contentHash: sha256Schema,
  skills: z.array(z.string().min(1).max(128)).max(100),
}).strict();
export const corpusManifestSchema = z.object({ schemaVersion: z.literal(1), ownerId: z.uuid(), version: versionNameSchema,
  visibility: z.literal('private'), dictionary: skillDictionarySchema,
  members: z.array(corpusMemberSchema).min(1).max(10_000),
}).strict().superRefine((value, context) => {
  const ids = value.members.map(member => member.jobVersionId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) {
    context.addIssue({ code: 'custom', path: ['members'], message: '语料成员必须按版本ID唯一升序排列' });
  }
});
export type SkillDictionary = z.infer<typeof skillDictionarySchema>;
export type CorpusManifest = z.infer<typeof corpusManifestSchema>;
