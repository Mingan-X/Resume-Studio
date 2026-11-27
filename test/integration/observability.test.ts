import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { trace } from '@opentelemetry/api';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { loadObservabilityConfig } from '../../src/infrastructure/observability/config.js';
import { ObservabilityModule, ObservabilityService } from '../../src/infrastructure/observability/observability.module.js';
import { assertObservabilityOwnership } from '../../src/infrastructure/observability/ownership.js';
import { runObservedGraph, syntheticSecrets } from '../fixtures/observability-graph.js';

const observationSchema = z.object({
  id: z.string(), traceId: z.string(), name: z.string(), parentObservationId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).passthrough();
const responseSchema = z.object({ data: z.array(observationSchema) });

await test('local Langfuse persists correlated callback/manual spans with no raw synthetic PII', { timeout: 90_000 }, async t => {
  const config = loadObservabilityConfig(process.env);
  assert.ok(config.enabled, 'Real Langfuse integration requires observability:init and running local services.');
  await assertObservabilityOwnership(true);
  const headers = { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}` };
  // Identify the failing HTTP boundary without exposing URLs, credentials, bodies or raw exceptions.
  async function request(stage: 'projects' | 'observations' | 'delete-trace', url: string | URL, method = 'GET', deadline = Infinity) {
    const start = performance.now();
    // Maintainer-authorized 2026-11-27: projects and observation reads both exceeded the former 5s ceiling.
    // Each request stays within the existing polling window and parent test deadline.
    const timeoutMs = Math.min(10_000, deadline - Date.now());
    if (timeoutMs <= 0) throw new Error('LANGFUSE_POLL_DEADLINE_EXCEEDED');
    try {
      const response = await fetch(url, { method, headers, signal: AbortSignal.any([t.signal, AbortSignal.timeout(timeoutMs)]) });
      t.diagnostic(JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - start), timeoutMs, status: response.status }));
      return response;
    }
    catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      t.diagnostic(JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - start), timeoutMs, timeout }));
      throw error; // preserve the original failure; the diagnostic identifies its phase
    }
  }
  const projects = await request('projects', `${config.baseUrl}/api/public/projects`);
  assert.equal(projects.status, 200);
  const projectList = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await projects.json());
  assert.deepEqual(projectList.data.map(project => project.id), ['resume-studio-diagnostics']);
  const module = await Test.createTestingModule({ imports: [ObservabilityModule.register(config)] }).compile();
  await module.init();
  const service = module.get(ObservabilityService);
  const correlationId = randomUUID();
  let traceId: string | undefined;
  try {
    const result = await service.run(correlationId, 'analysis', async () => {
      traceId = trace.getActiveSpan()?.spanContext().traceId;
      return runObservedGraph(service, correlationId);
    });
    assert.equal(result, 9);
    assert.ok(traceId);
    await service.flush();
    const stats = service.stats();
    assert.ok(stats && stats.exported > 0);
    assert.equal(Object.values(stats.lost).reduce((a, b) => a + b, 0), 0);
    const url = new URL('/api/public/v2/observations', config.baseUrl);
    url.searchParams.set('traceId', traceId);
    url.searchParams.set('fields', 'core,basic,io,metadata,trace_context');
    url.searchParams.set('limit', '100');
    const deadline = Date.now() + 45_000;
    let observations: z.infer<typeof observationSchema>[] = [];
    while (Date.now() < deadline) {
      const response = await request('observations', url, 'GET', deadline);
      assert.equal(response.status, 200);
      observations = responseSchema.parse(await response.json()).data;
      if (observations.length >= stats.exported) break;
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(500, remaining), undefined, { signal: t.signal });
    }
    assert.equal(observations.length, stats.exported, 'Every exported span must be persisted and readable.');
    assert.ok(observations.some(span => span.name === 'score' && span.parentObservationId));
    assert.ok(observations.some(span => span.name === 'synthetic-node' && span.parentObservationId));
    assert.ok(observations.every(span => span.traceId === traceId && span.metadata.correlationId === correlationId));
    const serialized = JSON.stringify(observations);
    for (const secret of Object.values(syntheticSecrets)) assert.ok(!serialized.includes(secret));
    assert.ok(serialized.includes('[REDACTED]'));
  } finally {
    await module.close();
    if (traceId) {
      // Only this invocation's random trace, in the verified diagnostics project.
      await assertObservabilityOwnership();
      const response = await request('delete-trace', `${config.baseUrl}/api/public/traces/${encodeURIComponent(traceId)}`, 'DELETE');
      assert.ok(response.ok || response.status === 404, 'Test trace deletion request failed.');
      await response.body?.cancel();
    }
  }
});
