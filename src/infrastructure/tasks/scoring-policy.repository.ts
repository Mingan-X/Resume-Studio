import { z } from 'zod';
import type { TransactionDatabase } from '../database/transaction-port.js';
import { scoringPolicySchema } from '../../contracts/scoring.js';
import { versionNameSchema } from '../../contracts/jobs.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

export class ScoringPolicyRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async import(owner: string, raw: unknown) {
    const ownerId = z.uuid().parse(owner), content = scoringPolicySchema.parse(raw), contentHash = requestHash(content);
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId, content.version])}, 25))::text`;
      const prior = await tx.scoringPolicy.findUnique({ where: { ownerId_version: { ownerId, version: content.version } } });
      if (prior) {
        if (requestHash(scoringPolicySchema.parse(prior.content)) !== prior.contentHash || prior.contentHash !== contentHash) throw new Error('SCORING_POLICY_CONFLICT');
      } else await tx.scoringPolicy.create({ data: { ownerId, version: content.version, content, contentHash } });
      return { content, contentHash, replay: !!prior };
    });
  }
  async load(owner: string, version: string) {
    const ownerId = z.uuid().parse(owner), name = versionNameSchema.parse(version);
    return this.database.client.$transaction(async tx => {
      const row = await tx.scoringPolicy.findUnique({ where: { ownerId_version: { ownerId, version: name } } });
      if (!row) return null;
      const content = scoringPolicySchema.parse(row.content);
      if (content.version !== name || requestHash(content) !== row.contentHash) throw new Error('SCORING_POLICY_INVALID');
      return { content, contentHash: row.contentHash };
    });
  }
}
