import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConsumeMessage } from 'amqplib';
import type { TransactionDatabase } from '../database/transaction-port.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import { ownerIdSchema } from '../../modules/identity/identity.module.js';
import { deadMessageSchema, quarantineMetadataSchema, quarantineCodeSchema } from '../../contracts/tasks.js';
import type { TaskType } from '../../contracts/tasks.js';
import { consumerName } from './contracts.js';

export class QuarantineStore {
  constructor(private readonly database: TransactionDatabase, private readonly identity: IdentityPort) {}

  async persist(delivery: ConsumeMessage, taskType: TaskType, error: unknown): Promise<void> {
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId());
    const errorCode = quarantineCodeSchema.parse(error), name = consumerName(taskType);
    const messageHash = createHash('sha256').update(delivery.content).digest('hex');
    const messageId = z.uuid().safeParse(delivery.properties.messageId);
    // Store hashes and allowlisted metadata only, including for malformed/non-UUID message IDs.
    const dedupeKey = createHash('sha256').update(JSON.stringify({ taskType, messageHash,
      messageId: typeof delivery.properties.messageId === 'string' ? delivery.properties.messageId : null,
      exchange: delivery.fields.exchange, route: delivery.fields.routingKey,
      contentType: typeof delivery.properties.contentType === 'string' ? delivery.properties.contentType : null,
    })).digest('hex');
    const safeMetadata = quarantineMetadataSchema.parse({ schemaVersion: 1, byteLength: delivery.content.length, source: taskType });
    await this.database.client.$transaction(async tx => {
      const id = randomUUID();
      const inserted = await tx.quarantine.createMany({ skipDuplicates: true, data: {
        id, ownerId, consumerName: name, dedupeKey, messageId: messageId.success ? messageId.data.toLowerCase() : null,
        messageHash, errorCode, safeMetadata,
      } });
      if (inserted.count === 0) {
        await tx.quarantine.findUniqueOrThrow({ where: { ownerId_consumerName_dedupeKey: { ownerId, consumerName: name, dedupeKey } } });
        return;
      }
      const eventId = randomUUID();
      await tx.outboxEvent.create({ data: { eventId, ownerId, aggregateType: 'Quarantine', aggregateId: id,
        eventType: taskType === 'analysis' ? 'analysis.dead.v1' : 'job.index.dead.v1', payloadVersion: 1,
        payload: deadMessageSchema.parse({ schemaVersion: 1, kind: 'dead', messageId: eventId, taskType,
          occurredAt: new Date().toISOString(), originalMessageId: messageId.success ? messageId.data : null, errorCode,
          source: { kind: 'quarantine', quarantineId: id, messageHash } }),
      } });
    });
  }
}
