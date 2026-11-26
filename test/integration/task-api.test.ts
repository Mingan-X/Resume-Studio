import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ApiModule } from '../../src/app-api.module.js';
import { configureHttp, createApi } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { TaskApiModule } from '../../src/modules/tasks/task-api.module.js';
import { IDENTITY } from '../../src/modules/identity/identity.module.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { PostgresExecutionLock } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { TaskFailure } from '../../src/infrastructure/consumer/failure.js';
import { ReconciliationStore } from '../../src/infrastructure/reconciliation/reconciliation.store.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import { taskDispatchSchema } from '../../src/contracts/tasks.js';
import type { TaskType } from '../../src/contracts/tasks.js';
import { taskResponseSchema, cancelTaskResponseSchema } from '../../src/contracts/task-api.js';
import { errorResponseSchema } from '../../src/contracts/http.js';
import { requestHash } from '../../src/modules/tasks/request-hash.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';

await test('S1.4-T8 real HTTP task ownership, progress and safe cancellation', { timeout: 180_000 }, async t => {
  await ownedPostgres();
  const config = loadInfrastructureConfig(process.env), ownerId = randomUUID(), foreignId = randomUUID();
  const admin = new DatabaseService(config), db = admin.client;
  const module = await Test.createTestingModule({ imports: [ApiModule.register(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000' }),
    [TaskApiModule.register(config)])] }).overrideProvider(IDENTITY).useValue({ getOwnerId: async () => ownerId }).compile();
  const app = module.createNestApplication({ logger: false }); configureHttp(app);
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const execution = new TaskExecutionStore(admin, consumerConfigSchema.parse({}));
  const reconciliation = reconciliationConfigSchema.parse({}), scan = new ReconciliationStore(admin);
  const children: ChildProcess[] = [], createdOwners: string[] = [];
  mkdirSync('data/s18-runs', { recursive: true }); const manifest = `data/s18-runs/${randomUUID()}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ ownerIds: createdOwners, cleaned }, null, 2)); save();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await app.close(); assert.equal(module.get(DatabaseService).pool.totalCount, 0);
    try {
      await ownedPostgres();
      for (const owner of createdOwners) {
        await db.$transaction(async tx => {
          const where = { ownerId: owner };
          await tx.nodeArtifact.deleteMany({ where }); await tx.syntheticIndexTarget.deleteMany({ where });
          await tx.consumerReceipt.deleteMany({ where }); await tx.taskEvent.deleteMany({ where });
          await tx.taskAttempt.deleteMany({ where }); await tx.outboxEvent.deleteMany({ where });
          await tx.analysisTask.deleteMany({ where }); await tx.jobIndexTask.deleteMany({ where });
          await tx.owner.delete({ where: { id: owner } });
        });
      }
      assert.equal(await db.owner.count({ where: { id: { in: createdOwners } } }), 0); save(true);
      t.diagnostic('T8 exact-run owners/tasks/events/receipts/outbox/artifacts removed; HTTP and database pools closed');
    } finally { await admin.onModuleDestroy(); assert.equal(admin.pool.totalCount, 0); }
  });
  for (const id of [ownerId, foreignId]) { await db.owner.create({ data: { id } }); createdOwners.push(id); save(); }
  async function create(type: TaskType, owner = ownerId) {
    const service = new TaskCreationService({ getOwnerId: async () => owner }, new TaskRepository(admin));
    const analysis = analysisInput(), index = jobIndexInput();
    analysis.budget.maxDurationMs = 180_000; index.budget.maxDurationMs = 180_000;
    const result = type === 'analysis' ? await service.createAnalysis(randomUUID(), analysis) : await service.createJobIndex(randomUUID(), index);
    const outbox = await db.outboxEvent.findFirstOrThrow({ where: { ownerId: owner, aggregateId: result.taskId } });
    return { ...result, message: taskDispatchSchema.parse(outbox.payload) };
  }
  async function query(id: string) {
    const response = await fetch(`${base}/api/v1/tasks/${id}`); assert.equal(response.status, 200);
    return taskResponseSchema.parse(await response.json());
  }
  async function cancel(id: string) {
    return fetch(`${base}/api/v1/tasks/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  }
  async function error(response: Response, status: number, code: string) {
    assert.equal(response.status, status); const body = errorResponseSchema.parse(await response.json());
    assert.equal(body.code, code); assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.equal(body.retryable, false); return body;
  }
  async function claimed(task: Awaited<ReturnType<typeof create>>) {
    const result = await execution.claim(ownerId, task.message); assert.equal(result.kind, 'acquired');
    if (result.kind !== 'acquired') throw new Error('Expected claim'); return result.claim;
  }

  await t.test('actual API assembly exposes enabled local task routes with a drained database pool on close', async () => {
    const local = await createApi(loadConfig('api', { APP_ENV: 'test', HTTP_PORT: '3000', TASK_API_ENABLED: 'true', DATABASE_URL: config.databaseUrl }));
    try { await local.listen(0, '127.0.0.1'); await error(await fetch(`${await local.getUrl()}/api/v1/tasks/${randomUUID()}`),404,'NOT_FOUND'); }
    finally { await local.close(); assert.equal(local.get(DatabaseService).pool.totalCount,0); }
  });
  await t.test('owner checks hide foreign resources; invalid IDs, query and cancellation bodies fail before writes', async () => {
    const foreign = await create('analysis',foreignId), own = await create('analysis');
    for (const id of [foreign.taskId,randomUUID()]) {
      await error(await fetch(`${base}/api/v1/tasks/${id}`,{headers:{'x-owner-id':foreignId}}),404,'NOT_FOUND');
      await error(await cancel(id),404,'NOT_FOUND');
    }
    await error(await fetch(`${base}/api/v1/tasks/invalid-id`),400,'VALIDATION_ERROR');
    await error(await fetch(`${base}/api/v1/tasks/${own.taskId}?ownerId=${foreignId}`),400,'VALIDATION_ERROR');
    for (const body of ['{"ownerId":"'+foreignId+'"}','null','[]']) await error(await fetch(`${base}/api/v1/tasks/${own.taskId}/cancel`,
      {method:'POST',headers:{'content-type':'application/json'},body}),400,body==='null'?'BAD_REQUEST':'VALIDATION_ERROR');
    await error(await fetch(`${base}/api/v1/tasks/${own.taskId}/cancel`,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}),400,'VALIDATION_ERROR');
    assert.equal((await query(own.taskId)).cancelRequested,false);
  });
  for (const type of ['analysis','job-index'] as const) {
    await t.test(`${type}: query reflects persisted stages/counts and retry details without execution internals`, async () => {
      const task = await create(type); const initial = await query(task.taskId);
      assert.deepEqual(initial.progress,{completed:0,total:null}); assert.equal(initial.attempt,0);assert.equal(initial.stage,'QUEUED');
      const claim=await claimed(task); assert.equal((await query(task.taskId)).stage,'SYNTHETIC_RUNNING');
      await execution.fail(claim,new TaskFailure('DEPENDENCY_UNAVAILABLE'));
      const retry=await query(task.taskId);assert.equal(retry.status,'RETRY_WAIT');assert.equal(retry.attempt,1);
      assert.deepEqual(retry.progress,{completed:0,total:1});assert.ok(retry.nextRetryAt);assert.equal(retry.error?.code,'DEPENDENCY_UNAVAILABLE');
      assert.equal(retry.error?.retryable,true);assert.equal(retry.reportId,null);
      for(const key of ['ownerId','fenceToken','leaseOwner','inputSnapshot','budgetUsage','activeGraphThreadId'])assert.equal(key in retry,false);
    });
    await t.test(`${type}: repeated cancellation requests are 202; reconciliation ends queued work without attempts or dead events`,async()=>{
      const task=await create(type);
      for(const response of await Promise.all([cancel(task.taskId),cancel(task.taskId)])) {
        assert.equal(response.status,202);assert.deepEqual(cancelTaskResponseSchema.parse(await response.json()),{taskId:task.taskId,cancelRequested:true});
      }
      assert.equal((await query(task.taskId)).status,'QUEUED');
      assert.ok((await scan.candidates(ownerId,type,undefined,100,reconciliation.staleMs)).includes(task.taskId));
      assert.equal(await execution.reconcile(ownerId,type,task.taskId,reconciliation),'cancelled');
      const final=await query(task.taskId);assert.equal(final.status,'CANCELLED');assert.equal(final.attempt,0);assert.equal(final.error,null);
      assert.equal(await db.outboxEvent.count({where:{ownerId,aggregateId:task.taskId,eventType:{endsWith:'.dead.v1'}}}),0);
      assert.equal((await execution.claim(ownerId,task.message)).kind,'ack');
      await error(await cancel(task.taskId),409,'INVALID_STATE');
      assert.equal(await db.taskEvent.count({where:{ownerId,taskId:task.taskId,stage:'CANCELLED'}}),1);
    });
    await t.test(`${type}: cancelled retry does not wait retryAt or consume another attempt`,async()=>{
      const task=await create(type),claim=await claimed(task);await execution.fail(claim,new TaskFailure('UPSTREAM_TIMEOUT'));
      assert.ok((await query(task.taskId)).nextRetryAt);assert.equal((await cancel(task.taskId)).status,202);
      const handler=new TaskDeliveryHandler(execution,{getOwnerId:async()=>ownerId},new SyntheticCompletionHandler(),consumerConfigSchema.parse({}),new PostgresExecutionLock(admin.pool));
      const next=await db.outboxEvent.findFirstOrThrow({where:{ownerId,aggregateId:task.taskId,payload:{path:['dispatchGeneration'],equals:2}}});
      assert.equal(await handler.handle(taskDispatchSchema.parse(next.payload),new AbortController().signal),'ack');
      const final=await query(task.taskId);assert.equal(final.status,'CANCELLED');assert.equal(final.nextRetryAt,null);assert.equal(final.attempt,1);
    });
    await t.test(`${type}: completion/cancel races serialize and stale writes cannot revive terminal state`,async()=>{
      const task=await create(type),claim=await claimed(task),output=await new SyntheticCompletionHandler().execute(claim,new AbortController().signal);
      const [request,complete]=await Promise.all([cancel(task.taskId),execution.complete(claim,output).then(()=>true,()=>false)]);
      if(request.status===202){await request.arrayBuffer();assert.equal(complete,false);await execution.markExecutionStopped(claim);assert.equal(await execution.cancelAtBoundary(claim),true);}
      else {await error(request,409,'INVALID_STATE');assert.equal(complete,true);}
      const final=await query(task.taskId);assert.ok(['SUCCEEDED','CANCELLED'].includes(final.status));
      await assert.rejects(execution.complete(claim,output));
      await assert.rejects(execution.nodeArtifact(claim,type==='analysis'?'first':'index',{schemaVersion:1,kind:'synthetic',node:type==='analysis'?'first':'index',inputHash:requestHash(claim.snapshot),value:1}));
      assert.deepEqual(await query(task.taskId),final);
      if(final.status==='SUCCEEDED')assert.deepEqual(final.progress,{completed:1,total:1});
    });
  }
  await t.test('read-only database rejects cancellation with safe HTTP 500 and keeps the task unchanged', async () => {
    const task = await create('analysis'), url = new URL(config.databaseUrl);
    url.searchParams.set('options','-c default_transaction_read_only=on');
    const readonly = new DatabaseService({ databaseUrl: url.toString() });
    const readModule = await Test.createTestingModule({ imports: [ApiModule.register(loadConfig('api',{APP_ENV:'test',HTTP_PORT:'3000'}),[TaskApiModule.register(config)])] })
      .overrideProvider(IDENTITY).useValue({ getOwnerId: async () => ownerId }).overrideProvider(DatabaseService).useValue(readonly).compile();
    const readApp = readModule.createNestApplication({logger:false});configureHttp(readApp);
    try {
      await readApp.listen(0,'127.0.0.1');const response=await fetch(`${await readApp.getUrl()}/api/v1/tasks/${task.taskId}/cancel`,
        {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      const payload=await error(response,500,'INTERNAL_ERROR');assert.ok(!JSON.stringify(payload).includes('SQL'));
      assert.equal((await query(task.taskId)).cancelRequested,false);
    } finally {await readApp.close();assert.equal(readonly.pool.totalCount,0);}
  });
  await t.test('SQL failure during cancellation rolls back task fence, attempt and receipt; recovery finishes once',async()=>{
    const task=await create('analysis'),claim=await claimed(task);assert.equal((await cancel(task.taskId)).status,202);
    const broken = db.$extends({query:{taskEvent:{create:({args,query})=>query({...args,data:{...args.data,stage:'x'.repeat(65)}})}}});
    const faultyModule = await Test.createTestingModule({ providers: [{ provide: DatabaseService, useValue: { client: broken } }] }).compile();
    const faulty = new TaskExecutionStore(faultyModule.get(DatabaseService),consumerConfigSchema.parse({}));
    try { await assert.rejects(faulty.reconcile(ownerId,'analysis',task.taskId,reconciliation)); }
    finally { await faultyModule.close(); }
    const row=await db.analysisTask.findUniqueOrThrow({where:{ownerId_id:{ownerId,id:task.taskId}}});
    assert.equal(row.status,'RUNNING');assert.equal(row.fenceToken,claim.fenceToken);assert.equal(row.cancelRequested,true);
    assert.equal((await db.taskAttempt.findUniqueOrThrow({where:{attemptId:claim.attemptId,ownerId}})).endedAt,null);
    assert.equal((await db.consumerReceipt.findFirstOrThrow({where:{ownerId,taskId:task.taskId}})).status,'RUNNING');
    assert.equal(await execution.reconcile(ownerId,'analysis',task.taskId,reconciliation),'cancelled');
    assert.equal(await execution.reconcile(ownerId,'analysis',task.taskId,reconciliation),'skipped');
    assert.equal(await db.taskEvent.count({where:{ownerId,taskId:task.taskId,stage:'CANCELLED'}}),1);
    assert.equal((await db.taskAttempt.findUniqueOrThrow({where:{attemptId:claim.attemptId,ownerId}})).executionStoppedAt,null);
  });
  await t.test('actual worker observes cancellation, retains lock through cleanup, then persists CANCELLED before ACK',async()=>{
    const task=await create('analysis');
    const child=fork(new URL('./task-cancel-worker.fixture.js',import.meta.url),[],{silent:true,execArgv:[],
      env:{...process.env,S18_OWNER_ID:ownerId,S18_MESSAGE:JSON.stringify(task.message)}});children.push(child);
    child.stdout?.resume();child.stderr?.resume();const exited=once(child,'exit');const events:string[]=[];
    child.on('message',input=>{const event=z.object({event:z.enum(['started','aborted','ack','deferred','failed'])}).parse(input);events.push(event.event);});
    const wait=async(event:string)=>{const deadline=Date.now()+10000;while(!events.includes(event)&&Date.now()<deadline){assert.ok(!events.includes('failed'));await delay(10);}assert.ok(events.includes(event));};
    await wait('started');assert.equal((await cancel(task.taskId)).status,202);await wait('aborted');
    assert.equal((await query(task.taskId)).status,'RUNNING');assert.equal(await execution.reconcile(ownerId,'analysis',task.taskId,reconciliation),'lock-held');
    child.send('release');await wait('ack');assert.equal((await exited)[0],0);
    assert.equal((await query(task.taskId)).status,'CANCELLED');
    const attempt=await db.taskAttempt.findFirstOrThrow({where:{ownerId,taskId:task.taskId}});assert.ok(attempt.executionStoppedAt);
    assert.equal((await db.consumerReceipt.findFirstOrThrow({where:{ownerId,taskId:task.taskId}})).status,'DONE');
    assert.equal(await db.taskEvent.count({where:{ownerId,taskId:task.taskId,stage:'SYNTHETIC_COMPLETED'}}),0);
  });
});
