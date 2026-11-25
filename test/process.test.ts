import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const entry = (role: 'api' | 'worker') => fileURLToPath(new URL(`../src/main-${role}.js`, import.meta.url));
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.APP_ENV;
  delete env.HTTP_HOST;
  delete env.HTTP_PORT;
  delete env.NODE_OPTIONS;
  return env;
};

await test('both real entrypoints fail closed on missing configuration without leaking values', () => {
  for (const role of ['api', 'worker'] as const) {
    for (const extra of [{}, { APP_ENV: 'private-marker' }]) {
      const child = spawnSync(process.execPath, [entry(role)], {
        env: { ...cleanEnv(), ...extra }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.ok(child.stderr.includes('CONFIG_INVALID'));
      assert.ok(child.stderr.includes('APP_ENV'));
      assert.ok(!child.stderr.includes('private-marker'));
    }
  }
});

await test('missing or invalid configuration exits without loading Nest or either bootstrap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'resume-studio-modules-'));
  try {
    for (const role of ['api', 'worker'] as const) {
      for (const extra of [{}, { APP_ENV: 'private-marker' }]) {
        const report = join(directory, `${role}.json`);
        const child = spawnSync(process.execPath, [
          '--import', new URL('./fixtures/module-load.fixture.js', import.meta.url).href, entry(role),
        ], { env: { ...cleanEnv(), ...extra, MODULE_LOAD_REPORT: report }, encoding: 'utf8', timeout: 10_000 });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 1);
        assert.equal(child.stdout, '');
        assert.ok(child.stderr.includes('CONFIG_INVALID'));
        assert.ok(!child.stderr.includes('private-marker'));
        const modules = z.array(z.string()).parse(JSON.parse(readFileSync(report, 'utf8')) as unknown)
          .map(url => decodeURIComponent(url).replaceAll('\\', '/'));
        assert.ok(modules.some(url => url.endsWith('/modules/config/app-config.js')));
        assert.ok(!modules.some(url => url.includes('/@nestjs/')), 'Invalid input loaded Nest.');
        assert.ok(!modules.some(url => /\/bootstrap(?:-api|-worker)?\.js$/.test(url)));
      }
    }
  } finally { rmSync(directory, { recursive: true }); }
});

await test('API and idle Worker run separately and close resources via the same shutdown path', { timeout: 20_000 }, async (t) => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

  for (const role of ['api', 'worker'] as const) {
    const child = fork(entry(role), [], {
      env: { ...cleanEnv(), APP_ENV: 'test', HTTP_PORT: String(port) }, silent: true,
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    const closed = once(child, 'close');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child ${role} did not start`)), 8_000);
      child.once('message', message => {
        clearTimeout(timer);
        try { assert.deepEqual(message, { type: 'ready', role }); resolve(); } catch (error) { reject(error); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Early exit ${code}: ${stderr}`)); });
    });
    assert.equal(child.exitCode, null);
    if (role === 'api') {
      const response = await fetch(`http://127.0.0.1:${port}/health?secret=private-marker`, {
        headers: { authorization: 'Bearer private-marker', 'x-request-id': 'private-marker' },
      });
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    }
    child.send('shutdown');
    const [exitCode] = await closed;
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.ok(!stdout.includes('private-marker'));
    const events = stdout.trim().split('\n').map(line => JSON.parse(line) as { event: string; role: string; requestId?: string });
    assert.equal(events[0]?.event, 'application_started');
    assert.equal(events.at(-1)?.event, 'application_stopped');
    assert.ok(events.every(event => event.role === role));
    if (role === 'api') {
      const completion = events.find(e => e.event === 'http_request_completed');
      const error = events.find(e => e.event === 'http_error');
      assert.ok(completion?.requestId);
      assert.equal(completion.requestId, error?.requestId);
    }
  }
  const rebound = createServer();
  t.after(() => new Promise<void>(resolve => rebound.close(() => resolve())));
  rebound.listen(port, '127.0.0.1');
  await once(rebound, 'listening');
});
