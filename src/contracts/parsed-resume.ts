import { z } from 'zod';
import { evidenceRefSchema } from './evidence.js';

const text = z.string().min(1).max(4000).nullable();
const date = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).nullable();
const sources = z.array(evidenceRefSchema).min(1).max(100);
export const parsedResumeSchema = z.object({
  schemaVersion: z.literal(1), resumeVersionId: z.uuid(),
  education: z.array(z.object({ institution: text, degree: text, field: text, startDate: date, endDate: date, sourceRefs: sources }).strict()).max(100),
  work: z.array(z.object({ employer: text, role: text, startDate: date, endDate: date, ongoing: z.boolean().nullable(),
    responsibilities: z.array(z.string().min(1).max(4000)).max(100), sourceRefs: sources }).strict()).max(100),
  projects: z.array(z.object({ name: text, role: text, description: text, technologies: z.array(z.string().min(1).max(128)).max(100), sourceRefs: sources }).strict()).max(100),
  skills: z.array(z.object({ name: z.string().min(1).max(128), context: text, sourceRefs: sources }).strict()).max(200),
}).strict();
export type ParsedResume = z.infer<typeof parsedResumeSchema>;
