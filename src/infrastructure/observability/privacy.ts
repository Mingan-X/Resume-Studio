import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { z } from 'zod';

export const correlationAttribute = 'resume.correlation_id';
export const observationNames = ['analysis', 'synthetic-analysis', 'synthetic-node', 'parse', 'extract', 'profile',
  'retrieve', 'match', 'score', 'report', 'observation'] as const;
export type ObservationName = typeof observationNames[number];
const names = new Set<string>(observationNames);
const cleanContext = (value: SpanContext): SpanContext => ({
  traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags,
});
const resource = resourceFromAttributes({ 'service.name': 'resume-studio', 'service.version': '0.1.0' });

// A whitelist rather than regex PII detection: raw prose, unknown keys, event/error
// text, resource metadata and tracestate never reach Langfuse or its async queue.
export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const attributes: Attributes = {};
  const id = z.uuid().safeParse(span.attributes[correlationAttribute]);
  if (id.success) {
    attributes[correlationAttribute] = id.data;
    attributes['langfuse.trace.metadata.correlationId'] = id.data;
    attributes['langfuse.observation.metadata.correlationId'] = id.data;
  }
  const type = z.enum(['span', 'chain', 'generation', 'tool', 'retriever']).safeParse(span.attributes['langfuse.observation.type']);
  if (type.success) attributes['langfuse.observation.type'] = type.data;
  for (const key of ['langfuse.internal.is_app_root', 'langfuse.internal.as_root']) {
    if (span.attributes[key] === true) attributes[key] = true;
  }
  for (const key of ['resume.completed', 'resume.total']) {
    const value = span.attributes[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) attributes[key] = value;
  }
  // Preserve the existence of inputs/outputs without their content.
  for (const key of ['langfuse.observation.input', 'langfuse.observation.output', 'langfuse.trace.input', 'langfuse.trace.output']) {
    if (key in span.attributes) attributes[key] = '[REDACTED]';
  }
  return {
    name: names.has(span.name) ? span.name : 'observation', kind: span.kind,
    spanContext: () => cleanContext(span.spanContext()),
    ...(span.parentSpanContext ? { parentSpanContext: cleanContext(span.parentSpanContext) } : {}),
    startTime: span.startTime, endTime: span.endTime, duration: span.duration,
    status: { code: span.status.code }, attributes, events: [], links: [],
    ended: span.ended, resource, instrumentationScope: { name: 'resume-studio' },
    droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}
