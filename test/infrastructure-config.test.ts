import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadInfrastructureConfig } from '../src/infrastructure/config.js';
import { ConfigValidationError } from '../src/modules/config/app-config.js';

const example = {
  INFRA_TEST_SCOPE: 'resume-studio-s12-test',
  DATABASE_URL: 'postgresql://resume_studio_test:synthetic@127.0.0.1:55432/resume_studio_s12_test',
  RABBITMQ_URL: 'amqp://resume_studio_test:synthetic@127.0.0.1:55672/resume-studio-s12-test',
  QDRANT_URL: 'http://127.0.0.1:56333', QDRANT_API_KEY: 'synthetic-marker-for-testing',
};

await test('infrastructure diagnostics refuse foreign databases, vhosts and remote servers', () => {
  assert.equal(loadInfrastructureConfig(example).databaseUrl, example.DATABASE_URL);
  for (const override of [
    { INFRA_TEST_SCOPE: 'production' },
    { DATABASE_URL: 'postgresql://resume_studio_test:synthetic@127.0.0.1:5432/resume_studio_s12_test' },
    { RABBITMQ_URL: 'amqp://resume_studio_test:synthetic@127.0.0.1:5672/resume-studio-s12-test' },
    { DATABASE_URL: 'not-a-url-synthetic' },
    { DATABASE_URL: 'postgresql://postgres:synthetic@localhost/resume_studio_s12_test' },
    { DATABASE_URL: 'postgresql://example:synthetic@example.com/resume_studio_s12_test' },
    { DATABASE_URL: 'postgresql://example:synthetic@localhost/other_project' },
    { RABBITMQ_URL: 'amqp://example:synthetic@localhost/' },
    { QDRANT_URL: 'http://example.com:6333' },
    { QDRANT_URL: 'not-a-url-synthetic' },
    { QDRANT_URL: 'http://localhost:6333/private' },
    { QDRANT_URL: 'http://localhost:6333?api-key=synthetic' },
  ]) {
    assert.throws(() => loadInfrastructureConfig({ ...example, ...override }), (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.ok(!error.message.includes('synthetic'));
      return true;
    });
  }
});
