import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseService } from '../database/database.service.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import type { TaskType } from '../../contracts/tasks.js';

export class ReconciliationStore {
  constructor(private readonly database: DatabaseService) {}

  async candidates(owner: string, type: TaskType, after: string | undefined, limit: number, staleMs: number) {
    const ownerId = ownerIdSchema.parse(owner);
    const cursor = after ? z.uuid().parse(after) : null;
    const table = type === 'analysis' ? Prisma.sql`analysis_task` : Prisma.sql`job_index_task`;
    const rows = await this.database.client.$queryRaw(Prisma.sql`
      SELECT id FROM ${table}
      WHERE owner_id = ${ownerId}::uuid AND cancel_requested = false AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
        AND ((status = 'RUNNING' AND (lease_until IS NULL OR lease_until <= statement_timestamp()))
          OR (status IN ('QUEUED','RETRY_WAIT') AND updated_at + ${staleMs} * interval '1 millisecond' <= statement_timestamp()
            AND (retry_at IS NULL OR retry_at <= statement_timestamp())))
      ORDER BY id LIMIT ${limit}`);
    return z.array(z.object({ id: z.uuid() })).max(limit).parse(rows).map(row => row.id);
  }

  async pendingSummary(owner: string) {
    const ownerId = ownerIdSchema.parse(owner);
    const rows = await this.database.client.$queryRaw`
      SELECT count(*)::int AS pending,
        count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed,
        count(*) FILTER (WHERE failed_at IS NULL AND available_at <= statement_timestamp()
          AND (lease_until IS NULL OR lease_until <= statement_timestamp()))::int AS due,
        min(created_at) AS "oldestCreatedAt"
      FROM outbox_event WHERE owner_id = ${ownerId}::uuid AND published_at IS NULL`;
    return z.array(z.object({ pending: z.int().nonnegative(), failed: z.int().nonnegative(), due: z.int().nonnegative(), oldestCreatedAt: z.date().nullable() }))
      .length(1).parse(rows)[0]!;
  }
}
