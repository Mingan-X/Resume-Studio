import { randomUUID } from 'node:crypto';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { requireAnalysisAuthority } from './analysis-artifact.repository.js';
import { profileAssessmentSchema } from '../../contracts/profile.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
export class ProfileRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async load(claim: ExecutionClaim) {
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const row = await tx.profileAssessment.findUnique({ where: { ownerId_taskId: { ownerId: claim.ownerId, taskId: claim.message.taskId } } });
      if (!row) return null;
      const content = profileAssessmentSchema.parse(row.content);
      if (content.taskId !== claim.message.taskId || requestHash(content) !== row.contentHash) throw new Error('PROFILE_HASH_INVALID');
      return { id: row.id, content };
    });
  }
  async save(claim: ExecutionClaim, raw: unknown) {
    const content = profileAssessmentSchema.parse(raw), contentHash = requestHash(content);
    return this.database.client.$transaction(async tx => {
      const snapshot = await requireAnalysisAuthority(tx, claim);
      if (content.taskId !== claim.message.taskId || content.resumeVersionId !== snapshot.resumeVersionId
        || content.rubricVersion !== snapshot.rubricVersion || content.rubricHash !== snapshot.rubricHash) throw new Error('PROFILE_INPUT_MISMATCH');
      const extraction = await tx.resumeExtraction.findFirst({ where: { ownerId: claim.ownerId, id: content.extractionId,
        resumeVersionId: snapshot.resumeVersionId, promptVersion: snapshot.promptVersion, modelConfigVersion: snapshot.modelConfigVersion } });
      if (!extraction) throw new Error('PROFILE_EXTRACTION_MISSING');
      const row = await tx.profileAssessment.findUnique({ where: { ownerId_taskId: { ownerId: claim.ownerId, taskId: claim.message.taskId } } });
      if (row) {
        if (row.contentHash !== contentHash || requestHash(profileAssessmentSchema.parse(row.content)) !== contentHash) throw new Error('PROFILE_CONFLICT');
        return { id: row.id, content };
      }
      const id = randomUUID(); await tx.profileAssessment.create({ data: { id, ownerId: claim.ownerId, taskId: claim.message.taskId, content, contentHash } });
      return { id, content };
    });
  }
}
