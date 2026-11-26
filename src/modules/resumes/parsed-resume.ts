import { parsedResumeSchema } from '../../contracts/parsed-resume.js';
import { extractedDocumentSchema } from '../../contracts/evidence.js';
import { validateEvidence } from './evidence.js';

export function validateParsedResume(ownerId: string, storedOwnerId: string, rawDocument: unknown, rawOutput: unknown) {
  const document = extractedDocumentSchema.parse(rawDocument), output = parsedResumeSchema.parse(rawOutput);
  if (output.resumeVersionId !== document.sourceVersionId || ownerId !== storedOwnerId) throw new Error('INVALID_PARSED_RESUME');
  for (const item of [...output.education, ...output.work, ...output.projects, ...output.skills]) {
    for (const reference of item.sourceRefs) validateEvidence(ownerId, storedOwnerId, document, reference);
  }
  return output;
}
