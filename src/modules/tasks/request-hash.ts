import { createHash } from 'node:crypto';
import { z } from 'zod';

// Sorting keys recursively makes JSON object order immaterial; array order remains significant.
const jsonSchema = z.json();
function canonical(value: z.infer<typeof jsonSchema>): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonical(jsonSchema.parse(value))).digest('hex');
}
