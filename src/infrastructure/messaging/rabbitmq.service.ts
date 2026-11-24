import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { connect } from 'amqplib';
import type { Channel, ChannelModel, ConfirmChannel, Message } from 'amqplib';
import { z } from 'zod';
import { INFRA_CONFIG } from '../tokens.js';
import type { InfrastructureConfig } from '../config.js';

export const diagnosticMessageSchema = z.object({
  schemaVersion: z.literal(1), messageId: z.uuid(), runId: z.uuid(),
  kind: z.literal('diagnostic'),
}).strict();
export type DiagnosticMessage = z.infer<typeof diagnosticMessageSchema>;

export class PublishError extends Error {
  constructor(readonly code: 'UNROUTABLE' | 'NACK' | 'CONNECTION_CLOSED' | 'CONFIRM_TIMEOUT') {
    super(code);
  }
}

type PendingPublish = { complete: (error?: PublishError) => void };

@Injectable()
export class RabbitmqService implements OnModuleDestroy {
  private connection: ChannelModel | undefined;
  private publisher: ConfirmChannel | undefined;
  private readonly pending = new Map<string, PendingPublish>();
  private available = false;

  constructor(@Inject(INFRA_CONFIG) private readonly config: InfrastructureConfig) {}

  async open(): Promise<void> {
    if (this.available) return;
    // Establish one connection explicitly; automatic reconnect is not implemented.
    if (this.connection) throw new Error('Connection unavailable; close this context before reconnecting.');
    const connection = await connect(this.config.rabbitmqUrl, { timeout: 5_000 });
    this.connection = connection;
    const failed = (): void => {
      this.available = false;
      for (const pending of this.pending.values()) pending.complete(new PublishError('CONNECTION_CLOSED'));
    };
    connection.on('error', failed);
    connection.on('close', failed);
    const channel = await connection.createConfirmChannel();
    channel.on('error', failed);
    channel.on('close', failed);
    channel.on('return', (message: Message) => {
      const id = message.properties.correlationId;
      if (id) this.pending.get(id)?.complete(new PublishError('UNROUTABLE'));
    });
    this.publisher = channel;
    this.available = true;
  }

  async createChannel(): Promise<Channel> {
    if (!this.available || !this.connection) throw new Error('RabbitMQ is not connected.');
    const channel = await this.connection.createChannel();
    channel.on('error', () => { /* The failed operation rejects; do not log broker error payloads. */ });
    return channel;
  }

  async publish(exchange: string, routingKey: string, message: DiagnosticMessage): Promise<void> {
    const content = Buffer.from(JSON.stringify(diagnosticMessageSchema.parse(message)));
    if (!this.publisher || !this.available) throw new PublishError('CONNECTION_CLOSED');
    const channel = this.publisher;
    // Correlate individual publish attempts, even when business messageId is repeated.
    const correlationId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.available = false;
        this.pending.get(correlationId)?.complete(new PublishError('CONFIRM_TIMEOUT'));
        void channel.close().catch(() => {});
      }, 5_000);
      this.pending.set(correlationId, {
        complete: (error) => {
          if (!this.pending.delete(correlationId)) return;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        },
      });
      try {
        // publish's boolean is only backpressure, not a broker acknowledgement.
        // Diagnostic callers await each publish, so at most one message is in flight per caller.
        channel.publish(exchange, routingKey, content, {
          persistent: true, mandatory: true, contentType: 'application/json',
          messageId: message.messageId, correlationId,
        }, (error: unknown) => {
          // RabbitMQ sends basic.return before confirm for an unroutable mandatory message.
          this.pending.get(correlationId)?.complete(error ? new PublishError('NACK') : undefined);
        });
      } catch {
        this.pending.get(correlationId)?.complete(new PublishError('CONNECTION_CLOSED'));
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.available = false;
    for (const pending of this.pending.values()) pending.complete(new PublishError('CONNECTION_CLOSED'));
    try { await this.publisher?.close(); } catch { /* Already closed after network failure. */ }
    try { await this.connection?.close(); } catch { /* Already closed after network failure. */ }
  }
}
