import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { loadCheckpointConfig } from '../../src/infrastructure/checkpoint/config.js';
import { createCheckpointStore } from '../../src/infrastructure/checkpoint/store.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import { confirmWorkerExit } from '../../src/infrastructure/consumer/worker-exit.js';
import type { ExecutionClaim } from '../../src/infrastructure/consumer/contracts.js';
import { syntheticNodeOutputSchema } from '../../src/infrastructure/consumer/contracts.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';
import { suspendChild } from '../support/process-suspension.js';
import { fenceWorkerMessageSchema } from './checkpoint-fence-worker.fixture.js';

type WorkerMessage = z.infer<typeof fenceWorkerMessageSchema>;
type Worker = { child: ChildProcess; label: string; suspended: boolean; exited: Promise<unknown[]>;
  event: <E extends WorkerMessage['event']>(name: E) => Promise<Extract<WorkerMessage, { event: E }>> };

await test('S1.4-T7 real paused workers, official checkpoints and fenced artifacts', { timeout: 240_000 }, async t => {
  await ownedPostgres();
  const dbService = new DatabaseService(loadInfrastructureConfig(process.env)), db = dbService.client;
  const checkpoints = createCheckpointStore(loadCheckpointConfig(process.env));
  const execution = new TaskExecutionStore(dbService, consumerConfigSchema.parse({}));
  const reconcileConfig = reconciliationConfigSchema.parse({});
  const owners: string[] = [], threads = new Set<string>();
  const workers: Worker[] = [];
  mkdirSync('data/s17-runs', { recursive: true }); const manifest = `data/s17-runs/${randomUUID()}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ ownerIds: owners, threadIds: [...threads], cleaned }, null, 2)); save();
  function spawn(ownerId: string, message: z.infer<typeof taskDispatchSchema>, mode: 'normal' | 'late-checkpoint' | 'before-invoke' | 'late-index' | 'normal-index', target?: string): Worker {
    const label = `s17-${randomUUID()}`;
    const env = { ...process.env, S17_OWNER_ID: ownerId, S17_MESSAGE: JSON.stringify(message), S17_LABEL: label,
      S17_MODE: mode, ...(target ? { S17_TARGET_ID: target } : {}), LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' };
    for (const key of ['CHECKPOINT_SETUP_URL','POSTGRES_ADMIN_PASSWORD','LANGSMITH_API_KEY','LANGCHAIN_API_KEY','NODE_OPTIONS']) delete env[key as keyof typeof env];
    const child = fork(new URL('./checkpoint-fence-worker.fixture.js', import.meta.url), [], { env, silent: true, execArgv: [] });
    const events: WorkerMessage[] = []; let invalid = false;
    child.stdout?.resume(); child.stderr?.resume();
    child.on('message', input => {
      const parsed = fenceWorkerMessageSchema.safeParse(input);
      if (!parsed.success) { invalid = true; return; }
      events.push(parsed.data);
      if (parsed.data.event === 'claimed' && parsed.data.identity.graph) { threads.add(parsed.data.identity.graph.threadId); save(); }
    });
    const exited = once(child, 'exit');
    const event = async <E extends WorkerMessage['event']>(name: E): Promise<Extract<WorkerMessage, { event: E }>> => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        assert.equal(invalid, false);
        const found = events.find((item): item is Extract<WorkerMessage, { event: E }> => item.event === name);
        if (found) return found;
        if (events.some(item => item.event === 'failed') || child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker ended before ${name}`);
        await delay(20);
      }
      throw new Error(`Worker event timed out: ${name}`);
    };
    const worker = { child, label, event, exited, suspended: false }; workers.push(worker); return worker;
  }
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        if (worker.suspended) await suspendChild(worker.child, 'resume').catch(() => {});
        worker.child.kill('SIGKILL'); await worker.exited;
      }
    }
    try {
      await ownedPostgres();
      for (const ownerId of owners) {
        const tasks = await db.analysisTask.findMany({ where: { ownerId }, select: { activeGraphThreadId: true } });
        for (const task of tasks) threads.add(task.activeGraphThreadId);
      }
      save();
      for (const thread of threads) { await checkpoints.saver.deleteThread(thread); assert.equal(await checkpoints.saver.getTuple({ configurable: { thread_id: thread } }), undefined); }
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.nodeArtifact.deleteMany({ where: { ownerId } }); await tx.syntheticIndexTarget.deleteMany({ where: { ownerId } });
          await tx.consumerReceipt.deleteMany({ where: { ownerId } }); await tx.taskEvent.deleteMany({ where: { ownerId } });
          await tx.taskAttempt.deleteMany({ where: { ownerId } }); await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.analysisTask.deleteMany({ where: { ownerId } }); await tx.jobIndexTask.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        assert.equal(await db.owner.count({ where: { id: ownerId } }), 0);
        assert.equal(await db.nodeArtifact.count({ where: { ownerId } }), 0);
      }
      save(true); t.diagnostic('T7 exact-run business data and all recorded checkpoint threads removed; no schema/volume reset');
    } finally { await checkpoints.close(); await dbService.onModuleDestroy(); assert.equal(checkpoints.pool.totalCount,0); assert.equal(dbService.pool.totalCount,0); }
  });
  async function analysis() {
    const ownerId = randomUUID(); await db.owner.create({ data: { id: ownerId } }); owners.push(ownerId); save();
    const input = analysisInput(); input.budget.maxDurationMs = 180_000; input.budget.maxAttempts = 5;
    const task = await new TaskCreationService({ getOwnerId: () => Promise.resolve(ownerId) }, new TaskRepository(dbService))
      .createAnalysis(randomUUID(), input);
    threads.add(task.taskId); save();
    const outbox = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: task.taskId } });
    return { ownerId, taskId: task.taskId, snapshot: { ...input, ownerId }, message: taskDispatchSchema.parse(outbox.payload) };
  }
  async function claimIdentity(c: Awaited<ReturnType<typeof analysis>>, w: ReturnType<typeof spawn>): Promise<ExecutionClaim> {
    const event = await w.event('claimed'), identity = event.identity;
    return { ownerId: c.ownerId, message: c.message, consumerName: c.message.taskType === 'analysis' ? 'analysis.worker.v1' : 'job-index.worker.v1',
      attemptId: identity.attemptId, fenceToken: BigInt(identity.fenceToken), startedAt: new Date(identity.startedAt), deadline: new Date(identity.deadline),
      snapshot: c.snapshot, ...(identity.graph ? { graph: identity.graph } : {}) };
  }
  async function expire(ownerId: string, taskId: string, type = 'analysis') {
    const table = type === 'analysis' ? 'analysis_task' : 'job_index_task';
    await dbService.pool.query(`UPDATE ${table} SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=$1::uuid AND id=$2::uuid`, [ownerId, taskId]);
  }
  async function terminateLock(label: string) {
    const rows = await dbService.pool.query("SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name=$1 AND a.usename=current_user AND l.locktype='advisory' AND l.granted", [label]);
    const pid = z.array(z.object({ pid: z.int().positive() })).length(1).parse(rows.rows)[0]!.pid;
    await dbService.pool.query('SELECT pg_terminate_backend($1::int)', [pid]);
  }
  async function nextMessage(ownerId: string, taskId: string) {
    const task = await db.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: taskId } } });
    const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: taskId,
      payload: { path: ['dispatchGeneration'], equals: task.generation } }, orderBy: { createdAt: 'desc' } });
    return taskDispatchSchema.parse(event.payload);
  }

  await t.test('unknown old worker is OS-suspended, new thread completes, late official saver writes only old thread', async () => {
    const c = await analysis(), old = spawn(c.ownerId, c.message, 'late-checkpoint');
    const oldClaim = await claimIdentity(c, old); await old.event('paused');
    assert.equal(await db.nodeArtifact.count({ where: { ownerId: c.ownerId, node: 'first' } }), 1);
    await assert.rejects(confirmWorkerExit(old.child, oldClaim, execution), /NOT_CONFIRMED/);
    await suspendChild(old.child, 'suspend'); old.suspended = true;
    await expire(c.ownerId, c.taskId);
    assert.equal(await execution.reconcile(c.ownerId,'analysis',c.taskId,reconcileConfig),'lock-held');
    await terminateLock(old.label);
    assert.equal(await execution.reconcile(c.ownerId,'analysis',c.taskId,reconcileConfig),'recovered');
    const message = await nextMessage(c.ownerId,c.taskId), fresh = spawn(c.ownerId, message, 'normal');
    const newIdentity = await fresh.event('claimed'); assert.ok(newIdentity.identity.graph);
    assert.notEqual(newIdentity.identity.graph.threadId, oldClaim.graph!.threadId);
    assert.equal(newIdentity.identity.graph.generation, oldClaim.graph!.generation + 1);
    assert.equal((await fresh.event('finished')).result,'ack'); assert.equal((await fresh.exited)[0],0);
    const newThread = newIdentity.identity.graph.threadId;
    const before = await checkpoints.saver.getTuple({ configurable:{thread_id:newThread} }); assert.ok(before);
    assert.equal(before.checkpoint.channel_values.value,9);
    const artifactsBefore = await db.nodeArtifact.findMany({ where:{ownerId:c.ownerId}, orderBy:{node:'asc'} });
    assert.equal(artifactsBefore.length,2); assert.equal(artifactsBefore[0]?.fenceToken,oldClaim.fenceToken);
    await suspendChild(old.child,'resume'); old.suspended=false; old.child.send('release');
    assert.equal((await old.event('late-checkpoint')).threadId,oldClaim.graph!.threadId);
    const stale = await old.event('stale-writes'); assert.equal(stale.artifactRejected,true); assert.equal(stale.terminalRejected,true);
    assert.equal((await old.event('finished')).result,'interrupted'); await old.exited;
    const after = await checkpoints.saver.getTuple({configurable:{thread_id:newThread}});
    assert.equal(after?.checkpoint.id,before.checkpoint.id); assert.deepEqual(after?.checkpoint.channel_values,before.checkpoint.channel_values);
    const oldCheckpoint=await checkpoints.saver.getTuple({configurable:{thread_id:oldClaim.graph!.threadId}});
    assert.equal(oldCheckpoint?.checkpoint.channel_values.step,'first'); // a real late persisted old checkpoint exists
    assert.deepEqual(await db.nodeArtifact.findMany({where:{ownerId:c.ownerId},orderBy:{node:'asc'}}),artifactsBefore);
    const task=await db.analysisTask.findUniqueOrThrow({where:{ownerId_id:{ownerId:c.ownerId,id:c.taskId}}});
    assert.equal(task.status,'SUCCEEDED');assert.equal(task.activeGraphThreadId,newThread);
  });

  for (const mode of ['late-checkpoint','before-invoke'] as const) {
    await t.test(`confirmed process exit allows same-thread ${mode === 'before-invoke' ? 'restart without checkpoint' : 'resume with checkpoint'} and reuses committed artifacts`,async()=>{
      const c=await analysis(),old=spawn(c.ownerId,c.message,mode),claim=await claimIdentity(c,old);await old.event('paused');
      if(mode==='before-invoke')assert.equal(await checkpoints.saver.getTuple({configurable:{thread_id:claim.graph!.threadId}}),undefined);
      else assert.ok(await checkpoints.saver.getTuple({configurable:{thread_id:claim.graph!.threadId}}));
      old.child.kill('SIGKILL');await old.exited;await confirmWorkerExit(old.child,claim,execution);
      await expire(c.ownerId,c.taskId);assert.equal(await execution.reconcile(c.ownerId,'analysis',c.taskId,reconcileConfig),'recovered');
      const fresh=spawn(c.ownerId,await nextMessage(c.ownerId,c.taskId),'normal');const started=await fresh.event('claimed');
      assert.equal(started.identity.graph?.threadId,claim.graph!.threadId);assert.equal(started.identity.graph?.generation,claim.graph!.generation);
      assert.equal((await fresh.event('finished')).result,'ack');assert.equal((await fresh.exited)[0],0);
      const stateAfter=await db.analysisTask.findUniqueOrThrow({where:{ownerId_id:{ownerId:c.ownerId,id:c.taskId}}});
      assert.equal(stateAfter.status,'SUCCEEDED',`Graph completion failed: ${stateAfter.errorCode}`);
      const artifacts=await db.nodeArtifact.findMany({where:{ownerId:c.ownerId},orderBy:{node:'asc'}});assert.equal(artifacts.length,2);
      if(mode==='late-checkpoint')assert.equal(artifacts[0]?.fenceToken,claim.fenceToken);
      assert.equal(syntheticNodeOutputSchema.parse(artifacts[1]?.validatedOutput).value,9);
      const row=await db.analysisTask.findUniqueOrThrow({where:{ownerId_id:{ownerId:c.ownerId,id:c.taskId}}});
      assert.equal(row.status,'SUCCEEDED');
      await assert.rejects(dbService.pool.query('UPDATE analysis_task SET graph_generation=0 WHERE owner_id=$1::uuid AND id=$2::uuid',[c.ownerId,c.taskId]),{code:'23514'});
    });
  }

  await t.test('paused old JobIndexTask cannot publish a newer target version or change its task terminal state',async()=>{
    const ownerId=randomUUID();await db.owner.create({data:{id:ownerId}});owners.push(ownerId);save();
    const identity={getOwnerId:()=>Promise.resolve(ownerId)},tasks=new TaskCreationService(identity,new TaskRepository(dbService));
    const oldInput=jobIndexInput();oldInput.budget.maxDurationMs=180000;
    const oldTask=await tasks.createJobIndex(randomUUID(),oldInput),targetId=randomUUID();
    await db.syntheticIndexTarget.create({data:{id:targetId,ownerId,jobVersionId:oldInput.jobVersionId,embeddingVersion:oldInput.embeddingVersion,indexVersion:oldInput.indexVersion}});
    const event=await db.outboxEvent.findFirstOrThrow({where:{ownerId,aggregateId:oldTask.taskId}}),message=taskDispatchSchema.parse(event.payload);
    const old=spawn(ownerId,message,'late-index',targetId);const started=await old.event('claimed');await old.event('paused');
    await suspendChild(old.child,'suspend');old.suspended=true;await terminateLock(old.label);await expire(ownerId,oldTask.taskId,'job-index');
    assert.equal(await execution.reconcile(ownerId,'job-index',oldTask.taskId,reconcileConfig),'recovered');
    const newInput=jobIndexInput();newInput.budget.maxDurationMs=180000;newInput.indexVersion='synthetic-v2';
    const newTask=await tasks.createJobIndex(randomUUID(),newInput);
    await db.syntheticIndexTarget.update({where:{ownerId_id:{ownerId,id:targetId}},data:{jobVersionId:newInput.jobVersionId,indexVersion:newInput.indexVersion,embeddingVersion:newInput.embeddingVersion,status:'PENDING'}});
    const newEvent=await db.outboxEvent.findFirstOrThrow({where:{ownerId,aggregateId:newTask.taskId}});
    const next=spawn(ownerId,taskDispatchSchema.parse(newEvent.payload),'normal-index',targetId);
    await next.event('claimed');assert.equal((await next.event('finished')).result,'ack');assert.equal((await next.exited)[0],0);
    const targetBefore=await db.syntheticIndexTarget.findUniqueOrThrow({where:{ownerId_id:{ownerId,id:targetId}}});
    await suspendChild(old.child,'resume');old.suspended=false;old.child.send('release');
    const stale=await old.event('stale-writes');assert.equal(stale.artifactRejected,true);assert.equal(stale.terminalRejected,true);assert.equal(stale.indexRejected,true);
    await old.event('finished');await old.exited;
    assert.deepEqual(await db.syntheticIndexTarget.findUniqueOrThrow({where:{ownerId_id:{ownerId,id:targetId}}}),targetBefore);
    assert.equal(targetBefore.completedByTaskId,newTask.taskId);assert.equal(targetBefore.status,'READY');
    assert.equal(await db.nodeArtifact.count({where:{ownerId,taskId:oldTask.taskId}}),0);
    const recoveredOld=await db.jobIndexTask.findUniqueOrThrow({where:{ownerId_id:{ownerId,id:oldTask.taskId}}});assert.equal(recoveredOld.status,'QUEUED');
    assert.ok(recoveredOld.fenceToken>BigInt(started.identity.fenceToken));
    // Even a fresh valid lease for the old input cannot point READY at the newer target.
    const recoverEvent=await db.outboxEvent.findFirstOrThrow({where:{ownerId,aggregateId:oldTask.taskId,payload:{path:['dispatchGeneration'],equals:recoveredOld.generation}}});
    const retry=await execution.claim(ownerId,taskDispatchSchema.parse(recoverEvent.payload));assert.equal(retry.kind,'acquired');
    if(retry.kind==='acquired')await assert.rejects(execution.publishSyntheticIndex(retry.claim,targetId),/LEASE_LOST/);
  });
});
