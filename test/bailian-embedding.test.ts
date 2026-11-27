import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { z } from 'zod';
import { BailianEmbedding } from '../src/infrastructure/models/bailian-embedding.js';
import { EmbeddingExecutor } from '../src/modules/embeddings/embedding-executor.js';

await test('S2.3 Bailian HTTP adapter validates formats/order/dimensions, redacts contacts and has no internal retry', async t => {
  let mode: 'ok' | 'base64' | 'wrong-dimension' | 'duplicate' | 'nan' | 'rate' | 'server' | 'json' | 'redirect' | 'oversize' | 'slow' = 'ok';
  let received = 0, followed = 0; const captures: unknown[] = [];
  const server = createServer((request, response) => {
    received++;
    if (request.url === '/redirect-target') { followed++; response.end('{}'); return; }
    assert.equal(request.headers.authorization, 'Bearer synthetic-test-key');
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8')); captures.push(body);
      const input = z.object({ input: z.array(z.string()), model: z.literal('text-embedding-v4'), dimensions: z.literal(64), encoding_format: z.literal('float') }).parse(body);
      response.setHeader('content-type', 'application/json');
      if (mode === 'slow') return;
      if (mode === 'rate') { response.writeHead(429).end('private upstream'); return; }
      if (mode === 'server') { response.writeHead(503).end('private upstream'); return; }
      if (mode === 'json') { response.end('invalid json private upstream'); return; }
      if (mode === 'redirect') { response.writeHead(302, { location: '/redirect-target' }).end(); return; }
      if (mode === 'oversize') { response.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
      const data = input.input.map((_text, index) => {
        let embedding: number[] | string = Array.from({ length: mode === 'wrong-dimension' ? 63 : 64 }, () => index + 0.25);
        if (mode === 'base64' || mode === 'nan') {
          const bytes = Buffer.alloc(64 * 4);
          for (let ordinal = 0; ordinal < 64; ordinal++) bytes.writeFloatLE(mode === 'nan' ? NaN : index + 0.25, ordinal * 4);
          embedding = bytes.toString('base64');
        }
        return { index: mode === 'duplicate' ? 0 : index, embedding };
      }).reverse();
      response.end(JSON.stringify({ model: input.model, data, usage: { prompt_tokens: 20, total_tokens: 20 } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { endpoint: `http://127.0.0.1:${address.port}/compatible-mode/v1/embeddings`, apiKey: 'synthetic-test-key',
    model: 'text-embedding-v4', dimensions: 64, embeddingVersion: 'bailian-fixture-v1', currency: 'CNY' };
  assert.throws(() => new BailianEmbedding(config), /ENDPOINT_INVALID/);
  assert.throws(() => new BailianEmbedding({ ...config, endpoint: 'https://evil.example/compatible-mode/v1/embeddings' }), /ENDPOINT_INVALID/);
  const port = new BailianEmbedding(config, { allowLocalTestEndpoint: true });
  const texts = ['合成 Node.js synthetic@example.test', '手机：13812345678\nTypeScript'];
  const result = await port.embed(texts, AbortSignal.timeout(2000));
  assert.deepEqual(result.vectors.map(vector => vector[0]), [0.25, 1.25]); assert.equal(result.usage?.costMicros, null);
  assert.doesNotMatch(JSON.stringify(captures), /synthetic@example.test|13812345678/);
  mode = 'base64'; assert.deepEqual(await port.embed(texts, AbortSignal.timeout(2000)), result);
  for (const scenario of ['wrong-dimension', 'duplicate', 'nan', 'json', 'redirect', 'oversize'] as const) {
    mode = scenario; received = 0;
    await assert.rejects(port.embed(texts, AbortSignal.timeout(2000)), { message: 'OUTPUT_INVALID' }); assert.equal(received, 1);
  }
  assert.equal(followed, 0);
  mode = 'rate'; received = 0;
  await assert.rejects(port.embed(texts, AbortSignal.timeout(2000)), { message: 'RATE_LIMITED' }); assert.equal(received, 1);
  mode = 'server'; await assert.rejects(port.embed(texts, AbortSignal.timeout(2000)), { message: 'UPSTREAM_5XX' });
  mode = 'slow'; const controller = new AbortController(), pending = port.embed(texts, controller.signal);
  controller.abort(); await assert.rejects(pending, { message: 'CANCELLED' });
  const executor = new EmbeddingExecutor(port, { singleTimeoutMs: 40, totalTimeoutMs: 1000, maxAttempts: 1,
    retryBaseMs: 1, retryCapMs: 2, maxConcurrent: 1, inputTokenReservation: 1024, costReservationMicros: 10,
    maxTokens: 1024, maxCostMicros: 10, currency: 'CNY' });
  received = 0; await assert.rejects(executor.run(texts), /TIMEOUT|UNSETTLED/); assert.equal(received, 1);
  await assert.rejects(port.embed(['长'.repeat(3000)], AbortSignal.timeout(2000)), /BUDGET_EXHAUSTED/);
});
