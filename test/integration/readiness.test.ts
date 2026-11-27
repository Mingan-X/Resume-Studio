import 'reflect-metadata';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../../src/app-api.module.js';
import { configureHttp } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { ReadinessModule, readinessDependencies } from '../../src/modules/health/readiness.module.js';
import { ReadinessService } from '../../src/modules/health/readiness.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit } from '../../src/infrastructure/messaging/ownership.js';
import { readinessResponseSchema, errorResponseSchema } from '../../src/contracts/http.js';
import { networkFaultProxy } from '../support/network-fault-proxy.js';

await test('S3.3 readiness HTTP reports real DB/broker transport loss, recovers and keeps liveness independent', { timeout: 45_000 }, async () => {
  await ownedPostgres(); await ownedRabbit(); const connection = loadInfrastructureConfig(process.env);
  const config = loadConfig('api', { APP_ENV: 'production', HTTP_PORT: '3000', AUTH_ENABLED: 'true', AUTH_ORIGIN: 'https://resume.example',
    TASK_API_ENABLED: 'true', READINESS_ENABLED: 'true', DATABASE_URL: connection.databaseUrl, RABBITMQ_URL: connection.rabbitmqUrl });
  const postgres = await networkFaultProxy(55432), rabbit = await networkFaultProxy(55672);
  const pgUrl = new URL(connection.databaseUrl), amqpUrl = new URL(connection.rabbitmqUrl);
  pgUrl.port = String(postgres.port); amqpUrl.port = String(rabbit.port);
  // Only test assembly substitutes the transport. Environment configuration retains strict project endpoints.
  const dependencies = readinessDependencies({ databaseUrl: pgUrl.toString(), rabbitmqUrl: amqpUrl.toString() });
  const module = await Test.createTestingModule({ imports: [ApiModule.register(config,
    [AuthModule.register(config.auth, true), ReadinessModule.register(config.readiness)])] })
    .overrideProvider(ReadinessService).useValue(dependencies.service).compile();
  const app = module.createNestApplication({ logger: false }); configureHttp(app);
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    assert.equal((await fetch(`${base}/ready?extra=1`)).status, 400);
    const ready = await fetch(`${base}/ready`); assert.equal(ready.status, 200); readinessResponseSchema.parse(await ready.json());
    for (const transport of [postgres, rabbit]) {
      transport.block(); await delay(1100);
      const started = performance.now(), failed = await fetch(`${base}/ready`);
      assert.equal(failed.status, 503); assert.ok(performance.now() - started < 6000);
      const body = errorResponseSchema.parse(await failed.json()); assert.equal(body.code, 'INTERNAL_ERROR'); assert.equal(body.retryable, true);
      assert.doesNotMatch(JSON.stringify(body), /postgres|amqp|password|SELECT|127\.0\.0\.1/i);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      transport.unblock(); await delay(1100); const recovered = await fetch(`${base}/ready`); assert.equal(recovered.status, 200); await recovered.body?.cancel();
    }
  } finally { await app.close(); await dependencies.close(); await postgres.close(); await rabbit.close(); }
});
