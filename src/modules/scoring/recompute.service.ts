import type { IdentityPort } from '../identity/identity.module.js';
import { ownerIdSchema } from '../identity/identity.module.js';
import type { ScoringRepository } from '../../infrastructure/tasks/scoring.repository.js';
export class RecomputeService {
  constructor(private readonly identity: IdentityPort, private readonly scores: Pick<ScoringRepository, 'recompute'>) {}
  async recompute(sourceScoreSetId: string, weights: unknown) {
    return this.scores.recompute(ownerIdSchema.parse(await this.identity.getOwnerId()), sourceScoreSetId, weights);
  }
}
