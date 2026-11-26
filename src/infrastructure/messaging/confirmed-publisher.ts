import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { connect } from 'amqplib';
import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';
import { taskDispatchSchema } from '../../contracts/tasks.js';
import type { TaskDispatch } from '../../contracts/tasks.js';
import { PublishError } from './rabbitmq.service.js';
import type { TaskTopology } from './task-topology.js';

export interface TaskPublisherPort {
  publish(message: TaskDispatch, signal?: AbortSignal): Promise<void>;
}

// A socket AbortSignal bounds handshake, channel RPC, confirm and cleanup together.
// Each attempt has its own connection/channel; a late confirm cannot complete a later attempt.
export async function withRabbitConnection<T>(url: string, timeoutMs: number,
  work: (connection: ChannelModel) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let removeAbort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new PublishError(signal?.aborted ? 'CONNECTION_CLOSED' : 'CONFIRM_TIMEOUT'));
    controller.signal.addEventListener('abort', fail, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', fail);
    if (controller.signal.aborted) fail();
  });
  const operation = (async () => {
    // amqplib forwards socket options to net.connect; its declarations omit Node's signal.
    const socketOptions = { timeout: timeoutMs, signal: controller.signal,
      clientProperties: { connection_name: 'resume-studio-outbox' } };
    const connection = await connect(url, socketOptions);
    connection.on('error', () => { /* Safe operation-level errors only. */ });
    if (controller.signal.aborted) throw new PublishError('CONFIRM_TIMEOUT');
    return work(connection);
  })();
  try { return await Promise.race([operation, interrupted]); }
  catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError('CONNECTION_CLOSED');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    removeAbort();
    controller.abort(); // destroys this attempt's socket even if close/handshake has stalled
  }
}

export function awaitConfirm(channel: EventEmitter & Pick<ConfirmChannel, 'publish'>, connection: EventEmitter,
  exchange: string, routingKey: string, message: TaskDispatch): Promise<void> {
  const correlationId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const complete = (error?: PublishError) => {
      if (settled) return;
      settled = true;
      channel.off('return', returned);
      channel.off('close', disconnected); channel.off('error', disconnected);
      connection.off('close', disconnected); connection.off('error', disconnected);
      if (error) reject(error); else resolve();
    };
    const returned = (returnedMessage: Message) => {
      if (returnedMessage.properties.correlationId === correlationId) complete(new PublishError('UNROUTABLE'));
    };
    const disconnected = () => complete(new PublishError('CONNECTION_CLOSED'));
    channel.on('return', returned);
    channel.on('close', disconnected); channel.on('error', disconnected);
    connection.on('close', disconnected); connection.on('error', disconnected);
    try {
      // false means buffer backpressure. With one in-flight message we wait for its confirm.
      channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)), {
        mandatory: true, persistent: true, messageId: message.messageId, correlationId,
        contentType: 'application/json', type: routingKey,
      }, (error: unknown) => complete(error ? new PublishError('NACK') : undefined));
    } catch { disconnected(); }
  });
}

export class ConfirmedTaskPublisher implements TaskPublisherPort {
  constructor(private readonly url: string, private readonly topology: TaskTopology,
    private readonly timeoutMs: number) {}

  async publish(input: TaskDispatch, signal?: AbortSignal): Promise<void> {
    const message = taskDispatchSchema.parse(input);
    await withRabbitConnection(this.url, this.timeoutMs, async connection => {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => { /* No raw broker errors in logs. */ });
      await awaitConfirm(channel, connection, this.topology.exchange,
        message.taskType === 'analysis' ? 'analysis.requested.v1' : 'job.index.requested.v1', message);
    }, signal);
  }
}
