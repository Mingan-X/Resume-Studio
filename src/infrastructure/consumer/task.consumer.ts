import { connect } from 'amqplib';
import type { ChannelModel, Channel, ConsumeMessage } from 'amqplib';
import { z } from 'zod';
import { decodeTaskDelivery, RejectedTaskDelivery } from './contracts.js';
import type { QuarantineStore } from './quarantine.store.js';
import type { TaskDeliveryHandler } from './task-delivery.handler.js';
import type { TaskType } from '../../contracts/tasks.js';
import { taskTypeSchema } from '../../contracts/tasks.js';
import type { TaskTopology } from '../messaging/task-topology.js';

const sessionSchema = z.object({
  windowMs: z.int().min(100).max(600_000).default(60_000),
  maxMessages: z.int().min(1).max(100).default(10),
}).strict();
export type ConsumerSessionResult = { received: number; acknowledged: number; reason: 'limit' | 'deadline' | 'stopped' | 'deferred' | 'error' };

export class TaskConsumer {
  constructor(private readonly url: string, private readonly topology: TaskTopology,
    private readonly handler: Pick<TaskDeliveryHandler, 'handle'>,
    private readonly quarantine?: Pick<QuarantineStore, 'persist'>) {}

  async run(taskType: TaskType, options: unknown = {}, signal?: AbortSignal): Promise<ConsumerSessionResult> {
    const type = taskTypeSchema.parse(taskType), settings = sessionSchema.parse(options);
    const abort = new AbortController();
    let connection: ChannelModel | undefined, channel: Channel | undefined;
    let active: Promise<void> = Promise.resolve();
    let received = 0, acknowledged = 0, finished = false, accepting = true;
    let resolve!: (value: ConsumerSessionResult) => void;
    const result = new Promise<ConsumerSessionResult>(done => { resolve = done; });
    const stop = (reason: ConsumerSessionResult['reason']) => {
      if (finished) return;
      finished = true;
      abort.abort(); // closes the original delivery channel via its socket; unACKed deliveries return to broker
      resolve({ received, acknowledged, reason });
    };
    const cancelled = () => stop('stopped');
    const deadline = setTimeout(() => stop('deadline'), settings.windowMs);
    const setupDeadline = setTimeout(() => stop('error'), Math.min(5_000, settings.windowMs));
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const setup = (async () => {
      if (finished) return;
      const socketOptions = { timeout: 5_000, signal: abort.signal,
        clientProperties: { connection_name: `resume-studio-consumer-${type}` } };
      connection = await connect(this.url, socketOptions);
      connection.on('error', () => stop('error')); connection.on('close', () => stop('error'));
      if (finished) return;
      channel = await connection.createChannel();
      channel.on('error', () => stop('error')); channel.on('close', () => stop('error'));
      await channel.prefetch(1);
      const receivingChannel = channel;
      const queue = type === 'analysis' ? this.topology.analysis : this.topology.jobIndex;
      await receivingChannel.consume(queue, (delivery: ConsumeMessage | null) => {
        if (finished || !accepting) return;
        if (!delivery) { stop('error'); return; }
        received++;
        active = (async () => {
          let disposition: 'ack' | 'deferred';
          try {
            const message = decodeTaskDelivery(delivery, type, this.topology.exchange);
            disposition = await this.handler.handle(message, abort.signal);
          } catch (error) {
            if (!(error instanceof RejectedTaskDelivery) || !this.quarantine || abort.signal.aborted) throw error;
            await this.quarantine.persist(delivery, type, error.code);
            disposition = 'ack'; // durable quarantine + dead outbox, never ACK just because decoding failed
          }
          if (finished || abort.signal.aborted) return;
          if (disposition === 'deferred') { stop('deferred'); return; }
          receivingChannel.ack(delivery); // never a different/reconnected channel
          acknowledged++;
          // Ordered RPC flushes the ACK before closing a completed bounded session.
          if (acknowledged >= settings.maxMessages) {
            accepting = false;
            await receivingChannel.checkQueue(queue);
            stop('limit');
          }
        })().catch(() => stop('error'));
      }, { noAck: false });
      clearTimeout(setupDeadline);
    })().catch(() => stop('error'));
    try { return await result; }
    finally {
      clearTimeout(deadline); clearTimeout(setupDeadline);
      signal?.removeEventListener('abort', cancelled); abort.abort();
      await setup; await active;
    }
  }
}
