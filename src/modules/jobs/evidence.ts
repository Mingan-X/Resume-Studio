import { z } from 'zod';
import { jdDocumentSchema, requirementsSchema } from '../../contracts/jobs.js';
import { textHash, validateEvidence } from '../resumes/evidence.js';

export function jdDocument(versionId: string, body: string) {
  const version = z.uuid().parse(versionId);
  const text = z.string().min(1).max(200_000).parse(body).replace(/\r\n?/g, '\n').normalize('NFC');
  const hash = textHash(text), hex = textHash(JSON.stringify([version, 'jd-text-v1', text]));
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return jdDocumentSchema.parse({ schemaVersion: 1, sourceType: 'JD', sourceVersionId: version,
    normalizationVersion: 'text-v1', chunkerVersion: 'jd-text-v1', textHash: hash,
    blocks: [{ id, ordinal: 0, text, textHash: hash, location: { kind: 'TEXT', paragraph: 0 } }],
  });
}
export function validateJobRequirements(ownerId: string, storedOwnerId: string, rawDocument: unknown, rawRequirements: unknown) {
  const document = jdDocumentSchema.parse(rawDocument), requirements = requirementsSchema.parse(rawRequirements);
  for (const item of requirements) validateEvidence(ownerId, storedOwnerId, document, item.sourceRef);
  return requirements;
}
