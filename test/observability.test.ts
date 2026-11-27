import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { loadObservabilityConfig } from '../src/infrastructure/observability/config.js';
import { ConfigValidationError } from '../src/modules/config/app-config.js';
import { ObservabilityService } from '../src/infrastructure/observability/observability.module.js';
import { correlationContext } from '../src/infrastructure/observability/processor.js';
import { runObservedGraph, syntheticSecrets } from './fixtures/observability-graph.js';

async function capture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = z.object({ port: z.number() }).parse(server.address()).port;
  return { url: `http://127.0.0.1:${port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

const config = (baseUrl: string, maxQueueSize = 128, exportTimeoutMs = 200) => ({
  enabled: true as const, baseUrl, publicKey: `pk-lf-${randomUUID()}`,
  secretKey: `sk-lf-${'a'.repeat(64)}`, maxQueueSize, exportTimeoutMs,
});
const documents: unknown[] = [];
const spanSchema = z.object({ traceId: z.string(), spanId: z.string(), parentSpanId: z.string().optional(),
  name: z.string(), attributes: z.array(z.object({ key: z.string(), value: z.object({ stringValue: z.string().optional() }).passthrough() })) });
const payloadSchema = z.object({ resourceSpans: z.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) })) });

await test('observability defaults off and rejects cloud endpoints or invalid budgets without revealing values', () => {
  assert.deepEqual(loadObservabilityConfig({}), { enabled: false });
  const env = { OBSERVABILITY_ENABLED: 'true', LANGFUSE_BASE_URL: 'http://127.0.0.1:53000',
    LANGFUSE_PUBLIC_KEY: `pk-lf-${randomUUID()}`, LANGFUSE_SECRET_KEY: `sk-lf-${'a'.repeat(64)}` };
  assert.equal(loadObservabilityConfig(env).enabled, true);
  for (const extra of [{ LANGFUSE_BASE_URL: 'https://cloud.langfuse.com' }, { OBSERVABILITY_ENABLED: 'yes' },
    { OBSERVABILITY_MAX_QUEUE_SIZE: '0' }, { OBSERVABILITY_EXPORT_TIMEOUT_MS: '99999' }, { LANGFUSE_SECRET_KEY: syntheticSecrets.secret }]) {
    assert.throws(() => loadObservabilityConfig({ ...env, ...extra }), (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.ok(!error.message.includes(syntheticSecrets.secret)); return true;
    });
  }
});

await test('Langfuse callbacks and manual spans share trace/correlation and strip raw data from captured OTLP', async () => {
  documents.length = 0;
  const server = await capture((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => { documents.push(JSON.parse(Buffer.concat(chunks).toString()) as unknown); response.end('{}'); });
  });
  const service = new ObservabilityService(config(server.url));
  const id = randomUUID();
  try {
    assert.equal(await runObservedGraph(service, id), 9);
    await service.run(id, 'analysis', async () => {
      const span = trace.getActiveSpan();
      span?.setAttribute('email', syntheticSecrets.email);
      span?.setAttribute('langfuse.trace.metadata.private', syntheticSecrets.secret);
      span?.recordException(new Error(syntheticSecrets.phone));
      span?.setStatus({ code: SpanStatusCode.ERROR, message: syntheticSecrets.secret });
      span?.updateName(syntheticSecrets.email);
    });
    await service.flush();
    const spans = documents.flatMap(document => payloadSchema.parse(document).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
    assert.ok(spans.length >= 3);
    const root = spans.find(span => span.name === 'synthetic-analysis' && !span.parentSpanId);
    assert.ok(root);
    const children = spans.filter(span => span.traceId === root.traceId && span.parentSpanId);
    assert.ok(children.some(span => span.name === 'score'));
    assert.ok(children.some(span => span.name === 'synthetic-node' || span.name === 'synthetic-analysis'));
    assert.ok(spans.every(span => span.attributes.some(attr => attr.key === 'resume.correlation_id' && attr.value.stringValue === id)));
    const serialized = JSON.stringify(documents);
    for (const secret of Object.values(syntheticSecrets)) assert.ok(!serialized.includes(secret));
    assert.ok(serialized.includes('[REDACTED]'));
    assert.equal(service.stats()?.outstanding, 0);
    assert.equal(service.stats()?.exported, spans.length);
  } finally { await service.onModuleDestroy(); await server.close(); }
});

await test('unavailable, slow and rejecting collectors cannot fail the graph; loss and time are bounded', async () => {
  for (const mode of ['closed', 'slow', 'reject', 'partial'] as const) {
    let received = 0;
    const server = await capture((_request, response) => {
      received++;
      if (mode === 'reject') { response.writeHead(503); response.end('private backend error'); }
      else if (mode === 'partial') response.end('{"partialSuccess":{"rejectedSpans":"1"}}');
      // slow deliberately never responds; the exporter must abort it.
    });
    if (mode === 'closed') await server.close();
    const service = new ObservabilityService(config(server.url, 16, 150));
    try {
      const started = performance.now();
      assert.equal(await runObservedGraph(service, randomUUID()), 9);
      await service.flush();
      assert.ok(performance.now() - started < 2000);
      assert.ok((service.stats()?.lost.transport ?? 0) > 0);
      assert.equal(service.stats()?.lastTransportFailure?.reason,
        mode === 'slow' ? 'timeout' : mode === 'reject' ? 'http' : mode === 'partial' ? 'invalid-ack' : 'connection');
      assert.doesNotMatch(JSON.stringify(service.stats()), /private backend error|sk-lf-/);
      assert.equal(service.stats()?.outstanding, 0);
      if (mode !== 'closed') assert.ok(received > 0, 'Fault must be exercised over the HTTP transport.');
    } finally { await service.onModuleDestroy(); if (mode !== 'closed') await server.close(); }
  }
});

await test('active and queued spans share a finite capacity and shutdown releases held requests', async () => {
  const server = await capture(() => {});
  const service = new ObservabilityService(config(server.url, 8, 500));
  try {
    const id = randomUUID();
    context.with(context.active().setValue(correlationContext, id), () => {
      const spans = Array.from({ length: 200 }, () => trace.getTracer('resume-studio').startSpan('score'));
      for (const span of spans) span.end();
    });
    await delay(20);
    assert.equal(service.stats()?.peakOutstanding, 8);
    assert.equal(service.stats()?.lost.capacity, 192);
    const started = performance.now();
    await service.onModuleDestroy();
    assert.ok(performance.now() - started < 1500);
    assert.equal(service.stats()?.outstanding, 0);
  } finally { await server.close(); }
});
