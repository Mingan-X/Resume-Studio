import { createContextKey } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { BoundedLangfuseExporter, ObservationMetrics } from './exporter.js';
import type { ObservabilityConfig } from './config.js';
import { correlationAttribute, sanitizeSpan } from './privacy.js';

export const correlationContext = createContextKey('resume-studio-correlation');

export class PrivateSpanProcessor implements SpanProcessor {
  readonly metrics = new ObservationMetrics();
  private readonly admitted = new Set<string>();
  private readonly delegate: LangfuseSpanProcessor;
  private stopped = false;
  private readonly exporter: BoundedLangfuseExporter;

  constructor(private readonly config: Extract<ObservabilityConfig, { enabled: true }>) {
    this.exporter = new BoundedLangfuseExporter(config, this.metrics);
    this.delegate = new LangfuseSpanProcessor({
      ...config, exporter: this.exporter, exportMode: 'immediate', mediaUploadEnabled: false,
      shouldExportSpan: () => true, environment: 'local', release: 's1.3',
    });
  }

  onStart(span: Span, parent: Context): void {
    if (this.stopped || this.metrics.outstanding >= this.config.maxQueueSize) {
      this.metrics.lose(this.stopped ? 'shutdown' : 'capacity', 1); return;
    }
    this.metrics.accepted++;
    this.metrics.outstanding++;
    this.metrics.peakOutstanding = Math.max(this.metrics.peakOutstanding, this.metrics.outstanding);
    this.admitted.add(span.spanContext().spanId);
    const id = parent.getValue(correlationContext);
    if (typeof id === 'string') span.setAttribute(correlationAttribute, id);
    this.delegate.onStart(span, parent);
  }

  onEnd(span: ReadableSpan): void {
    if (!this.admitted.delete(span.spanContext().spanId)) return;
    try { this.delegate.onEnd(sanitizeSpan(span)); }
    catch { this.metrics.outstanding--; this.metrics.lose('processing', 1); }
  }

  async forceFlush(): Promise<void> {
    try { await this.delegate.forceFlush(); } catch { /* Export outcomes are already counted. */ }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    // Abandon running operations rather than waiting for unfinished business spans.
    this.metrics.lose('shutdown', this.admitted.size);
    this.metrics.outstanding -= this.admitted.size;
    this.admitted.clear();
    await this.exporter.shutdown();
    await this.delegate.shutdown();
  }
}
