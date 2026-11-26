import { z } from 'zod';
import { editJobDraftSchema } from '../../contracts/job-drafts.js';
import { jobVersionSchema } from '../../contracts/jobs.js';
import type { JobVersion } from '../../contracts/jobs.js';
import { jdDocument, validateJobRequirements } from './evidence.js';

export function editDraft(original: JobVersion, rawEdit: unknown, next: { id: string; version: number; createdAt: string }): JobVersion {
  const source = jobVersionSchema.parse(original), edit = editJobDraftSchema.parse(rawEdit);
  validateJobRequirements(source.ownerId, source.ownerId, source.document, source.requirements);
  if (edit.kind === 'requirement-upsert') validateJobRequirements(source.ownerId, source.ownerId, source.document, [edit.requirement]);
  const id = z.uuid().parse(next.id);
  if (source.status === 'DRAFT' && (id !== source.id || next.version !== source.version || next.createdAt !== source.createdAt)) throw new Error('DRAFT_IDENTITY_MISMATCH');
  if (source.status === 'PUBLISHED' && (id === source.id || next.version <= source.version)) throw new Error('NEW_DRAFT_VERSION_REQUIRED');
  const body = edit.kind === 'body' ? edit.body : source.document.blocks[0]!.text;
  const document = jdDocument(id, body);
  let requirements = structuredClone(source.requirements);
  if (edit.kind === 'requirement-delete') {
    if (!requirements.some(item => item.stableId === edit.stableId)) throw new Error('JOB_REQUIREMENT_NOT_FOUND');
    requirements = requirements.filter(item => item.stableId !== edit.stableId);
  }
  if (edit.kind === 'requirement-upsert') {
    const index = requirements.findIndex(item => item.stableId === edit.requirement.stableId);
    if (index < 0) requirements.push(edit.requirement); else requirements[index] = edit.requirement;
  }
  requirements = requirements.map(item => ({ ...item, sourceRef: { ...item.sourceRef,
    sourceVersionId: id, blockId: document.blocks[0]!.id,
  } }));
  // Never guess a new quotation location after edits. Unchanged exact ranges may be rebound;
  // invalidated requirements must first be explicitly removed or replaced by the user.
  try { validateJobRequirements(source.ownerId, source.ownerId, document, requirements); }
  catch { throw new Error('JD_EDIT_INVALIDATES_REQUIREMENTS'); }
  return jobVersionSchema.parse({ ...source, ...next, document, requirements,
    ...(edit.kind === 'metadata' ? edit.metadata : {}),
    dimensionWeights: edit.kind === 'weights' ? edit.dimensionWeights : source.dimensionWeights,
    status: 'DRAFT', contentHash: null, publishedAt: null, indexStatus: 'NOT_REQUESTED',
    hardRequirementsConfirmed: false, weightsConfirmed: false,
  });
}
