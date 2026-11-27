import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { OpenAiModel } from '../src/infrastructure/models/openai-model.js';
import { ModelFailure } from '../src/modules/models/model.port.js';

await test('OpenAI-compatible adapter uses JSON Schema, no hidden retries, redacted messages and bounded HTTP', { timeout: 20000 }, async () => {
  let mode = 'ok', calls = 0;
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    calls++; let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      assert.equal(req.url, '/v1/chat/completions');
      if (mode === 'slow') return;
      if (['429','503','400'].includes(mode)) { res.writeHead(Number(mode), { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'private-key-do-not-expose' } })); return; }
      res.setHeader('content-type', 'application/json');
      if (mode === 'invalid-json') { res.end('not-json'); return; }
      if (mode === 'large') { res.end('x'.repeat(3000)); return; }
      const content = mode === 'invalid-content' ? '{broken' : JSON.stringify(mode === 'extra' ? { value: 'ok', totalScore: 100 } : { value: 'ok' });
      res.end(JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion', created: 1, model: 'configured-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        ...(mode === 'no-usage' ? {} : { usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }) }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = z.object({ port: z.number() }).parse(server.address());
  const config = { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-local-key', model: 'configured-model',
    modelConfigVersion: 'relay-test-v1', timeoutMs: 500, maxResponseBytes: 2048, currency: 'CNY' };
  const model = new OpenAiModel(config), input = { messages: [new HumanMessage('联系 test@example.invalid，电话 13800138000，TypeScript')], schema: z.object({ value: z.string() }).strict(), maxOutputTokens: 50 };
  try {
    const result = await model.invoke(input, new AbortController().signal);
    assert.deepEqual(result.output, { value: 'ok' }); assert.equal(result.usage?.inputTokens, 11); assert.equal(result.usage?.costMicros, null);
    const request = z.object({ response_format: z.object({ type: z.literal('json_schema'), json_schema: z.object({ strict: z.literal(true) }) }), model: z.literal('configured-model') }).parse(requests[0]);
    assert.equal(request.model, config.model); assert.ok(!JSON.stringify(requests).includes('test@example.invalid')); assert.ok(!JSON.stringify(requests).includes('13800138000'));
    for (const [next, code] of [['429','RATE_LIMITED'],['503','UPSTREAM_5XX'],['400','UNSUPPORTED_MODEL'],['invalid-content','OUTPUT_INVALID'],['extra','OUTPUT_INVALID'],['large','OUTPUT_INVALID'],['slow','TIMEOUT']] as const) {
      mode = next; const before = calls;
      await assert.rejects(model.invoke(input, new AbortController().signal), (error: unknown) => error instanceof ModelFailure && error.code === code && !error.message.includes('private-key'));
      assert.equal(calls, before + 1, 'SDK must not multiply retries');
    }
    mode = 'no-usage'; assert.equal((await model.invoke(input, new AbortController().signal)).usage, null);
    mode = 'invalid-json'; await assert.rejects(model.invoke(input, new AbortController().signal), ModelFailure);
    const signal = new AbortController(); signal.abort(); const before = calls;
    await assert.rejects(model.invoke(input, signal.signal), /CANCELLED/); assert.equal(calls, before);
    assert.throws(() => new OpenAiModel({ ...config, baseURL: 'http://remote.invalid/v1' }), /MODEL_CONFIG_INVALID/);
    const prior = process.env.LANGSMITH_TRACING; process.env.LANGSMITH_TRACING = 'true';
    try { await assert.rejects(model.invoke(input, new AbortController().signal), /UNAVAILABLE/); }
    finally { if (prior === undefined) delete process.env.LANGSMITH_TRACING; else process.env.LANGSMITH_TRACING = prior; }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
