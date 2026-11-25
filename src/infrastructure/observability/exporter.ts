import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ObservabilityConfig } from './config.js';

export type LossReason = 'capacity' | 'expired' | 'transport' | 'shutdown' | 'processing';
export class ObservationMetrics {
  accepted = 0;
  exported = 0;
  outstanding = 0;
  peakOutstanding = 0;
  lost: Record<LossReason, number> = { capacity: 0, expired: 0, transport: 0, shutdown: 0, processing: 0 };

  lose(reason: LossReason, count: number): void {
    this.lost[reason] += count;
  }

  snapshot() {
    return { accepted: this.accepted, exported: this.exported, outstanding: this.outstanding,
      peakOutstanding: this.peakOutstanding, lost: { ...this.lost } };
  }
}

type Item = { spans: ReadableSpan[]; done: (result: ExportResult) => void; expires: number };

// Official OTLP JSON serialization with a single bounded HTTP attempt. Native fetch
// aborts the request at the total deadline, with no SDK retry layers or redirects.
export class BoundedLangfuseExporter implements SpanExporter {
  private readonly queue: Item[] = [];
  private running: Promise<void> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;

  constructor(private readonly config: Extract<ObservabilityConfig, { enabled: true }>,
    private readonly metrics: ObservationMetrics) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    if (this.stopped) { this.finish({ spans, done, expires: 0 }, 'shutdown'); return; }
    this.queue.push({ spans, done, expires: Date.now() + this.config.exportTimeoutMs * 2 });
    this.start();
  }

  private start(): void {
    if (this.running) return;
    // Schedule after this turn to coalesce immediate SDK exports into small batches.
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = undefined;
      if (this.queue.length) this.start();
    });
  }

  private finish(item: Item, reason?: LossReason): void {
    this.metrics.outstanding -= item.spans.length;
    if (reason) this.metrics.lose(reason, item.spans.length);
    else this.metrics.exported += item.spans.length;
    // Failure details are deliberately not passed into the SDK diagnostic logger.
    item.done({ code: reason ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, 16);
      const live = batch.filter(item => {
        if (item.expires > Date.now()) return true;
        this.finish(item, 'expired'); return false;
      });
      if (!live.length) continue;
      const remaining = Math.min(this.config.exportTimeoutMs, ...live.map(item => item.expires - Date.now()));
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort(), Math.max(1, remaining));
      let reason: LossReason | undefined;
      try {
        const payload = JsonTraceSerializer.serializeRequest(live.flatMap(item => item.spans));
        if (!payload || payload.byteLength > 128 * 1024) throw new Error('Bounded payload exceeded.');
        const response = await fetch(`${this.config.baseUrl}/api/public/otel/v1/traces`, {
          method: 'POST', redirect: 'error', signal: this.controller.signal,
          headers: { 'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString('base64')}`,
            'x-langfuse-ingestion-version': '4', 'x-langfuse-sdk-name': 'javascript',
            'x-langfuse-sdk-version': '6.1.1', 'x-langfuse-public-key': this.config.publicKey },
          body: Buffer.from(payload),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Export rejected.'); }
        // Consume a bounded OTLP acknowledgement; partial rejection counts as loss.
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (response.body) for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 4096) { this.controller.abort(); throw new Error('Oversized acknowledgement.'); }
          chunks.push(chunk);
        }
        if (bytes) {
          const ack = JsonTraceSerializer.deserializeResponse(Buffer.concat(chunks));
          if (Number(ack.partialSuccess?.rejectedSpans ?? 0) > 0) throw new Error('Partial rejection.');
        }
      } catch { reason = this.stopped ? 'shutdown' : 'transport'; }
      finally { clearTimeout(timer); this.controller = undefined; }
      for (const item of live) this.finish(item, reason);
    }
  }

  async forceFlush(): Promise<void> { while (this.running) await this.running; }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    for (const item of this.queue.splice(0)) this.finish(item, 'shutdown');
    await this.forceFlush();
  }
}
