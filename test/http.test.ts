import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../src/app-api.module.js';
import { configureHttp } from '../src/bootstrap-api.js';
import { loadConfig } from '../src/modules/config/app-config.js';
import { errorResponseSchema, healthResponseSchema } from '../src/contracts/http.js';
import { IdempotencyConflictError } from '../src/modules/tasks/task-errors.js';

// This controller is registered only in the test module, never in the running API.
@Controller('test-only')
class FailureController {
  @Get('failure')
  fail(): never { throw new Error('private-marker SQL password'); }

  @Post('conflict')
  conflict(): never { throw new IdempotencyConflictError(); }

  @Post('body')
  body(): { ok: true } { return { ok: true }; }
}

await test('compiled ESM Nest HTTP chain validates input and returns safe correlated errors', async (t) => {
  const module = await Test.createTestingModule({
    imports: [ApiModule.register(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000' }))],
    controllers: [FailureController],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  t.after(() => app.close());
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  await t.test('health controller receives its service and configuration through DI', async () => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(healthResponseSchema.parse(await response.json()), {
      status: 'ok', service: 'api', environment: 'test',
    });
    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  await t.test('invalid query and unknown route share the error contract', async () => {
    for (const [route, status, code] of [
      ['/health?private-marker=value', 400, 'VALIDATION_ERROR'],
      ['/missing/private-marker', 404, 'NOT_FOUND'],
      ['/test-only/failure', 500, 'INTERNAL_ERROR'],
    ] as const) {
      const response = await fetch(url + route);
      assert.equal(response.status, status);
      const body = errorResponseSchema.parse(await response.json());
      assert.equal(body.code, code);
      assert.equal(body.requestId, response.headers.get('x-request-id'));
      assert.ok(!JSON.stringify(body).includes('private-marker'));
      assert.ok(!JSON.stringify(body).includes('SQL'));
    }
  });

  await t.test('malformed JSON is sanitized even before the controller runs', async () => {
    const response = await fetch(`${url}/test-only/body`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"private-marker":',
    });
    assert.equal(response.status, 400);
    const body = errorResponseSchema.parse(await response.json());
    assert.equal(body.code, 'BAD_REQUEST');
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(body).includes('private-marker'));
  });

  await t.test('task idempotency conflict maps to a safe HTTP 409', async () => {
    const response = await fetch(`${url}/test-only/conflict`, { method: 'POST' });
    assert.equal(response.status, 409);
    const body = errorResponseSchema.parse(await response.json());
    assert.equal(body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(body.retryable, false);
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.equal(body.message, '该幂等键已用于不同的请求');
  });

  await t.test('concurrent requests receive independent server-generated request IDs', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${url}/health`, {
      headers: { 'x-request-id': 'private-marker' },
    })));
    const ids = responses.map(r => r.headers.get('x-request-id'));
    assert.equal(new Set(ids).size, responses.length);
    assert.ok(ids.every(id => id !== null && id !== 'private-marker'));
    await Promise.all(responses.map(r => r.arrayBuffer()));
  });
});
