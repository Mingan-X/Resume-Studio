import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from '../database/database.service.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import type { OutboxConfig } from './config.js';

export const claimSchema = z.object({
  eventId: z.uuid(), ownerId: z.uuid(), aggregateType: z.string(), aggregateId: z.uuid(),
  eventType: z.string(), payloadVersion: z.int(), payload: z.unknown(),
  publishAttempts: z.int().nonnegative(), leaseOwner: z.uuid().nullable(),
  createdAt: z.date(), failedAt: z.date().nullable(),
});
export type OutboxClaim = z.infer<typeof claimSchema>;

export class OutboxStore {
  constructor(private readonly database: DatabaseService, private readonly config: OutboxConfig) {}

  async claim(owner: string): Promise<OutboxClaim | null> {
    const ownerId = ownerIdSchema.parse(owner);
    const token = randomUUID();
    const { maxAttempts, maxAgeMs, leaseMs } = this.config;
    // One atomic statement is a short transaction. Expired last attempts are exhausted here too,
    // so a crash on the final attempt cannot silently restart an unbounded publish cycle.
    const result = await this.database.client.$queryRaw`
      WITH candidate AS (
        SELECT event_id,
          (publish_attempts >= ${maxAttempts}
            OR created_at + ${maxAgeMs} * interval '1 millisecond' <= statement_timestamp()) AS exhausted
        FROM outbox_event
        WHERE owner_id = ${ownerId}::uuid AND published_at IS NULL AND failed_at IS NULL
          AND available_at <= statement_timestamp()
          AND (lease_until IS NULL OR lease_until <= statement_timestamp())
        ORDER BY available_at, created_at, event_id
        LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_event AS event SET
        lease_owner = CASE WHEN candidate.exhausted THEN NULL ELSE ${token}::uuid END,
        lease_until = CASE WHEN candidate.exhausted THEN NULL ELSE statement_timestamp() + ${leaseMs} * interval '1 millisecond' END,
        publish_attempts = event.publish_attempts + CASE WHEN candidate.exhausted THEN 0 ELSE 1 END,
        failed_at = CASE WHEN candidate.exhausted THEN statement_timestamp() ELSE NULL END,
        last_error_code = CASE WHEN candidate.exhausted THEN 'PUBLISH_BUDGET_EXHAUSTED' ELSE event.last_error_code END
      FROM candidate WHERE event.event_id = candidate.event_id AND event.owner_id = ${ownerId}::uuid
      RETURNING event.event_id AS "eventId", event.owner_id AS "ownerId", event.aggregate_type AS "aggregateType",
        event.aggregate_id AS "aggregateId", event.event_type AS "eventType", event.payload_version AS "payloadVersion",
        event.payload, event.publish_attempts AS "publishAttempts", event.lease_owner AS "leaseOwner",
        event.created_at AS "createdAt", event.failed_at AS "failedAt"`;
    return z.array(claimSchema).max(1).parse(result)[0] ?? null;
  }

  async markPublished(claim: OutboxClaim): Promise<boolean> {
    const count = await this.database.client.$executeRaw`
      UPDATE outbox_event SET published_at = statement_timestamp(), lease_owner = NULL, lease_until = NULL, last_error_code = NULL
      WHERE event_id = ${claim.eventId}::uuid AND owner_id = ${claim.ownerId}::uuid
        AND lease_owner = ${claim.leaseOwner}::uuid AND lease_until > statement_timestamp()
        AND published_at IS NULL AND failed_at IS NULL`;
    return count === 1;
  }

  async markFailed(claim: OutboxClaim, code: string, delayMs: number, permanent: boolean): Promise<boolean> {
    const errorCode = z.enum(['UNROUTABLE', 'NACK', 'CONNECTION_CLOSED', 'CONFIRM_TIMEOUT', 'INVALID_EVENT']).parse(code);
    const delay = z.int().nonnegative().max(this.config.retryMaxMs).parse(delayMs);
    const { maxAttempts, maxAgeMs } = this.config;
    const count = await this.database.client.$executeRaw`
      UPDATE outbox_event SET
        failed_at = CASE WHEN ${permanent} OR publish_attempts >= ${maxAttempts}
          OR created_at + ${maxAgeMs} * interval '1 millisecond' <= statement_timestamp()
          THEN statement_timestamp() ELSE NULL END,
        available_at = LEAST(statement_timestamp() + ${delay} * interval '1 millisecond',
          created_at + ${maxAgeMs} * interval '1 millisecond'),
        last_error_code = ${errorCode}, lease_owner = NULL, lease_until = NULL
      WHERE event_id = ${claim.eventId}::uuid AND owner_id = ${claim.ownerId}::uuid
        AND lease_owner = ${claim.leaseOwner}::uuid AND lease_until > statement_timestamp()
        AND published_at IS NULL AND failed_at IS NULL`;
    return count === 1;
  }
}
