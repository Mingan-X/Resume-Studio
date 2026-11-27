import 'reflect-metadata';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { z } from 'zod';
import { ownedPostgres } from '../dist/src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit } from '../dist/src/infrastructure/messaging/ownership.js';
import { loadInfrastructureConfig } from '../dist/src/infrastructure/config.js';
import { DatabaseService } from '../dist/src/infrastructure/database/database.service.js';
import { createCheckpointStore } from '../dist/src/infrastructure/checkpoint/store.js';
import { loadCheckpointConfig } from '../dist/src/infrastructure/checkpoint/config.js';
import { LocalStorage } from '../dist/src/infrastructure/storage/local-storage.js';
import { requestHash } from '../dist/src/modules/tasks/request-hash.js';
import { seedRealAnalysis, cleanRealAnalysis } from '../dist/test/support/real-analysis.js';
import { verifyProjectNetwork } from '../dist/test/support/project-network.js';

const execute = promisify(execFile), runId = randomUUID(), ownerId = randomUUID();
const project = `resume-studio-restore-${runId}`, directory = resolve('data/s33-restore', runId);
const database = new DatabaseService(loadInfrastructureConfig(process.env)), checkpoints = createCheckpointStore(loadCheckpointConfig(process.env));
const targets = [], report = { schemaVersion: 1, runId, ownerId, project, stage: 'preflight', databases: [], filesVerified: false, definitionsVerified: false, cleaned: false };
const save = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(report, null, 2));
async function docker(args, binary = false) {
  try { return (await execute('docker', args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout; }
  catch { throw new Error('RESTORE_DOCKER_OPERATION_FAILED'); }
}
async function sql(container, db, query) {
  return (await docker(['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'resume_studio_owner', '-d', db, '-At', '-c', query])).trim();
}
async function inspectTarget(id, service) {
  const [info] = z.array(z.object({ Id: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    HostConfig: z.object({ NetworkMode: z.literal('none') }),
    Mounts: z.array(z.object({ Type: z.literal('tmpfs') })),
  })).length(1).parse(JSON.parse(await docker(['inspect', id])));
  assert.equal(info.Id, id); assert.equal(info.Config.Labels['com.docker.compose.project'], project);
  assert.equal(info.Config.Labels['com.docker.compose.service'], service); assert.equal(info.Config.Labels['resume-studio.restore-run'], runId);
}
async function startTarget(service, image, args, ready) {
  const id = z.string().regex(/^[a-f0-9]{64}$/).parse((await docker(['run', '-d', '--network', 'none', '--label', `com.docker.compose.project=${project}`,
    '--label', `com.docker.compose.service=${service}`, '--label', `resume-studio.restore-run=${runId}`, ...args, image])).trim());
  targets.push({ id, service }); report.targets = targets; await save(); await inspectTarget(id, service);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { await docker(['exec', ...(service === 'rabbitmq-restore' ? ['--user', 'rabbitmq'] : []), id, ...ready]); return id; }
    catch {
      const state = z.object({ Status: z.string() }).parse(JSON.parse(await docker(['inspect', '--format', '{{json .State}}', id])));
      if (state.Status === 'exited') throw new Error('RESTORE_TARGET_EXITED');
      await delay(1000);
    }
  }
  throw new Error('RESTORE_TARGET_NOT_READY');
}
async function fingerprint(container, db, schema) {
  const tables = (await sql(container, db, `SELECT tablename FROM pg_tables WHERE schemaname='${schema}' ORDER BY tablename`)).split('\n').filter(Boolean);
  const result = [];
  for (const table of tables) {
    z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).parse(table);
    const value = await sql(container, db, `SET statement_timeout='5s'; SELECT count(*)::text || ':' || md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) FROM "${schema}"."${table}" t`);
    result.push({ table, value: value.split('\n').at(-1) });
  }
  return result;
}
await mkdir(directory, { recursive: true, mode: 0o700 }); await save();
try {
  const pg = await ownedPostgres(), rabbit = await ownedRabbit(); await verifyProjectNetwork(pg); await verifyProjectNetwork(rabbit);
  const nonterminal = { in: ['QUEUED', 'RUNNING', 'RETRY_WAIT'] };
  assert.equal(await database.client.analysisTask.count({ where: { status: nonterminal } }), 0);
  assert.equal(await database.client.jobIndexTask.count({ where: { status: nonterminal } }), 0);
  report.stage = 'seed'; await save();
  await seedRealAnalysis(database, ownerId);
  report.stage = 'checkpoint-seed'; await save();
  const state = Annotation.Root({ value: Annotation() });
  const graph = new StateGraph(state).addNode('increment', state => ({ value: state.value + 1 }))
    .addEdge(START, 'increment').addEdge('increment', END).compile({ checkpointer: checkpoints.saver });
  assert.equal((await graph.invoke({ value: 41 }, { configurable: { thread_id: runId }, durability: 'sync' })).value, 42);
  report.stage = 'file-backup'; await save();
  const sourceFiles = join(directory, 'source-files'), storage = await LocalStorage.create(sourceFiles);
  const file = await storage.stage(Readable.from([Buffer.from('Synthetic restore evidence, no personal data.')])); await storage.commit(file);
  await cp(sourceFiles, join(directory, 'files-backup'), { recursive: true, errorOnExist: true, force: false });
  const restoredFiles = await LocalStorage.create(join(directory, 'restored-files'));
  report.stage = 'file-restore'; await save();
  for (const child of ['files', 'staging']) for (const entry of await readdir(join(directory, 'files-backup', child))) {
    z.uuid().parse(entry);
    await cp(join(directory, 'files-backup', child, entry), join(restoredFiles.root, child, entry), { recursive: true, errorOnExist: true, force: false });
  }
  assert.equal(createHash('sha256').update(await restoredFiles.read(file.storageKey)).digest('hex'), file.sha256);
  report.filesVerified = true; report.file = { storageKey: file.storageKey, sha256: file.sha256, size: file.size };
  report.stage = 'postgres-start'; await save();
  const pgImage = (await docker(['inspect', '--format', '{{.Image}}', pg])).trim();
  const target = await startTarget('postgres-restore', pgImage, ['--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
    '-e', 'POSTGRES_USER=resume_studio_owner', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust'], ['pg_isready', '-U', 'resume_studio_owner']);
  for (const [db, schema] of [['resume_studio_s12_test', 'public'], ['resume_studio_checkpoint', 'langgraph']]) {
    report.stage = `restore-${db}`; await save();
    assert.equal(await ownedPostgres(), pg); await verifyProjectNetwork(pg);
    const before = await fingerprint(pg, db, schema), backup = join(directory, `${db}.dump`);
    const bytes = await docker(['exec', pg, 'pg_dump', '-U', 'resume_studio_owner', '-d', db, '-Fc', '--no-owner', '--no-acl', '--serializable-deferrable'], true);
    await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await fingerprint(pg, db, schema), before, 'Source changed while backing up; quiesce and create a new drill');
    await inspectTarget(target, 'postgres-restore'); await sql(target, 'postgres', `CREATE DATABASE "${db}"`);
    await docker(['cp', backup, `${target}:/tmp/restore.dump`]);
    await docker(['exec', target, 'pg_restore', '-U', 'resume_studio_owner', '-d', db, '--exit-on-error', '--no-owner', '--no-acl', '/tmp/restore.dump']);
    assert.deepEqual(await fingerprint(target, db, schema), before);
    report.databases.push({ database: db, tables: before.length, contentHash: requestHash(before), dumpSha256: createHash('sha256').update(bytes).digest('hex') }); await save();
  }
  await inspectTarget(target, 'postgres-restore'); await docker(['rm', '-f', target]); targets.splice(targets.findIndex(item => item.id === target), 1); await save();
  assert.equal(await ownedRabbit(), rabbit); await verifyProjectNetwork(rabbit);
  report.stage = 'definitions-export'; await save();
  const sourcePath = `/tmp/s33-${runId}.json`, definitions = join(directory, 'rabbit-definitions.json');
  await docker(['exec', rabbit, 'rabbitmqctl', 'export_definitions', sourcePath]);
  try { await docker(['cp', `${rabbit}:${sourcePath}`, definitions]); }
  finally { assert.equal(await ownedRabbit(), rabbit); await verifyProjectNetwork(rabbit); await docker(['exec', rabbit, 'rm', '--', sourcePath]); }
  const rabbitImage = (await docker(['inspect', '--format', '{{.Image}}', rabbit])).trim();
  const uid = z.coerce.number().int().positive().max(65535).parse((await docker(['exec', rabbit, 'id', '-u', 'rabbitmq'])).trim());
  const gid = z.coerce.number().int().positive().max(65535).parse((await docker(['exec', rabbit, 'id', '-g', 'rabbitmq'])).trim());
  report.stage = 'rabbitmq-start'; await save();
  const broker = await startTarget('rabbitmq-restore', rabbitImage, ['--hostname', 's33-restore', '--user', 'rabbitmq', '--tmpfs', `/var/lib/rabbitmq:rw,size=256m,uid=${uid},gid=${gid},mode=0700`], ['rabbitmq-diagnostics', '-q', 'check_running']);
  await docker(['cp', definitions, `${broker}:/tmp/definitions.json`]);
  await docker(['exec', '--user', '0', broker, 'chown', `${uid}:${gid}`, '/tmp/definitions.json']);
  await docker(['exec', '--user', 'rabbitmq', broker, 'chmod', '600', '/tmp/definitions.json']);
  await docker(['exec', '--user', 'rabbitmq', broker, 'rabbitmqctl', 'import_definitions', '/tmp/definitions.json']);
  report.stage = 'definitions-verify'; await save();
  await docker(['exec', '--user', 'rabbitmq', broker, 'rabbitmqctl', 'export_definitions', '/tmp/restored.json']);
  const restoredDefinitions = join(directory, 'restored-definitions.json'); await docker(['cp', `${broker}:/tmp/restored.json`, restoredDefinitions]);
  const definitionSchema = z.object(Object.fromEntries(['users', 'vhosts', 'permissions', 'topic_permissions', 'parameters', 'global_parameters', 'policies', 'queues', 'exchanges', 'bindings']
    .map(key => [key, z.array(z.record(z.string(), z.json()))])));
  const expected = definitionSchema.parse(JSON.parse(await readFile(definitions, 'utf8'))), restored = definitionSchema.parse(JSON.parse(await readFile(restoredDefinitions, 'utf8')));
  for (const key of Object.keys(expected)) for (const entry of expected[key]) assert.ok(restored[key].some(item => requestHash(item) === requestHash(entry)), `Missing restored definition in ${key}`);
  report.definitionsVerified = true; report.definitionsHash = requestHash(expected); await save();
  console.log(JSON.stringify({ code: 'RESTORE_DRILL_VERIFIED', runId, databases: report.databases, filesVerified: true, definitionsVerified: true }));
} catch { console.error(JSON.stringify({ code: 'RESTORE_DRILL_FAILED', runId, stage: report.stage })); process.exitCode = 1; }
finally {
  try {
    for (const { id, service } of targets) { await inspectTarget(id, service); await docker(['rm', '-f', id]); }
    await verifyProjectNetwork(await ownedPostgres()); await checkpoints.saver.deleteThread(runId);
    assert.equal(await database.client.taskAttempt.count({ where: { ownerId } }), 0);
    await cleanRealAnalysis(database, ownerId); report.cleaned = true; report.targets = []; await save();
  } finally { await checkpoints.close(); await database.onModuleDestroy(); }
}
