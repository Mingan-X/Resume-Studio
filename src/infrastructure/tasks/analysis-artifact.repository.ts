import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { ExecutionLeaseLostError } from '../consumer/contracts.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import { analysisNodeIdentitySchema, analysisNodeArtifactSchema } from '../../contracts/analysis-graph.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

export async function requireAnalysisAuthority(tx: Prisma.TransactionClient, claim: ExecutionClaim) {
  if (claim.message.taskType !== 'analysis' || !claim.graph) throw new ExecutionLeaseLostError();
  const rows = await tx.$queryRaw`SELECT input_snapshot AS snapshot FROM analysis_task
    WHERE owner_id=${claim.ownerId}::uuid AND id=${claim.message.taskId}::uuid AND status='RUNNING' AND cancel_requested=false
    AND generation=${claim.message.dispatchGeneration} AND fence_token=${claim.fenceToken} AND lease_owner=${claim.attemptId}::uuid
    AND lease_until>clock_timestamp() AND ${claim.deadline}>clock_timestamp()
    AND active_graph_thread_id=${claim.graph.threadId}::uuid AND graph_generation=${claim.graph.generation} FOR UPDATE`;
  const found = z.array(z.object({ snapshot: realAnalysisInputSchema })).max(1).parse(rows)[0];
  if (!found || requestHash(found.snapshot) !== requestHash(claim.snapshot)) throw new ExecutionLeaseLostError();
  return found.snapshot;
}

export class AnalysisArtifactRepository {
  constructor(private readonly database: TransactionDatabase) {}
  async node(claim: ExecutionClaim, rawIdentity: unknown, output?: unknown) {
    const snapshot = realAnalysisInputSchema.parse(claim.snapshot), identity = analysisNodeIdentitySchema.parse(rawIdentity);
    if (identity.promptVersion !== snapshot.promptVersion || identity.modelConfigVersion !== snapshot.modelConfigVersion) throw new Error('ARTIFACT_VERSION_MISMATCH');
    const operationKey = requestHash({ ownerId: claim.ownerId, taskType: 'analysis', taskId: claim.message.taskId, ...identity });
    return this.database.client.$transaction(async tx => {
      await requireAnalysisAuthority(tx, claim);
      const existing = await tx.nodeArtifact.findUnique({ where: { operationKey, ownerId: claim.ownerId } });
      if (existing) {
        const value = analysisNodeArtifactSchema.parse(existing.validatedOutput);
        if (requestHash(value.identity) !== requestHash(identity) || existing.taskId !== claim.message.taskId
          || existing.node !== identity.node || existing.branchKey !== identity.branchKey || existing.inputHash !== identity.inputHash
          || existing.promptVersion !== identity.promptVersion || existing.modelConfigVersion !== identity.modelConfigVersion) throw new Error('ARTIFACT_IDENTITY_MISMATCH');
        if (output !== undefined && requestHash(analysisNodeArtifactSchema.parse({ schemaVersion: 1, kind: 'analysis-node', identity, result: output })) !== requestHash(value)) throw new Error('ARTIFACT_CONFLICT');
        return { id: existing.id, ...value };
      }
      if (output === undefined) return null;
      const value = analysisNodeArtifactSchema.parse({ schemaVersion: 1, kind: 'analysis-node', identity, result: output }), id = randomUUID();
      await requireAnalysisAuthority(tx, claim);
      await tx.nodeArtifact.create({ data: { id, operationKey, ownerId: claim.ownerId, taskType: 'ANALYSIS',
        taskId: claim.message.taskId, analysisTaskId: claim.message.taskId, ...identity, fenceToken: claim.fenceToken, validatedOutput: value } });
      return { id, ...value };
    });
  }
}
