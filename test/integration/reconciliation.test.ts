import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from 'amqplib';
import { Pool } from 'pg';
import { z } from 'zod';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import type { TransactionDatabase } from '../../src/infrastructure/database/transaction-port.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { ownedRabbit, rabbitAdmin } from '../../src/infrastructure/messaging/ownership.js';
import { taskTopology, declareTaskTopology } from '../../src/infrastructure/messaging/task-topology.js';
import { installTaskPolicy } from '../../src/infrastructure/messaging/task-topology.admin.js';
import { ConfirmedTaskPublisher } from '../../src/infrastructure/messaging/confirmed-publisher.js';
import { TaskCreationService } from '../../src/modules/tasks/task-creation.service.js';
import { TaskRepository } from '../../src/infrastructure/tasks/task.repository.js';
import { TaskExecutionStore } from '../../src/infrastructure/consumer/task-execution.store.js';
import { TaskDeliveryHandler, SyntheticCompletionHandler } from '../../src/infrastructure/consumer/task-delivery.handler.js';
import { PostgresExecutionLock, executionLockKey } from '../../src/infrastructure/consumer/task-execution.lock.js';
import { TaskConsumer } from '../../src/infrastructure/consumer/task.consumer.js';
import { consumerConfigSchema } from '../../src/infrastructure/consumer/config.js';
import { OutboxStore } from '../../src/infrastructure/outbox/outbox.store.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox.publisher.js';
import { outboxConfigSchema } from '../../src/infrastructure/outbox/config.js';
import { reconciliationConfigSchema } from '../../src/infrastructure/reconciliation/config.js';
import { ReconciliationService } from '../../src/infrastructure/reconciliation/reconciliation.service.js';
import { ReconciliationStore } from '../../src/infrastructure/reconciliation/reconciliation.store.js';
import { taskDispatchSchema, budgetUsageSchema, deadMessageSchema } from '../../src/contracts/tasks.js';
import type { TaskType } from '../../src/contracts/tasks.js';
import { analysisInput, jobIndexInput } from '../support/task-inputs.js';

await test('S1.4-T6 real PostgreSQL reconciliation locks, recovery and delivery', { timeout: 180_000 }, async t => {
  await ownedPostgres(); await ownedRabbit();
  const config = loadInfrastructureConfig(process.env), database = new DatabaseService(config), db = database.client;
  const topology = taskTopology(`s12.t6.${randomUUID().replaceAll('-', '')}`), owners: string[] = [];
  const queues = [topology.analysis, topology.jobIndex, topology.analysisDead, topology.jobIndexDead];
  mkdirSync('data/s16-runs', { recursive: true });
  const manifest = `data/s16-runs/${topology.namespace}.json`;
  const save = (cleaned = false) => writeFileSync(manifest, JSON.stringify({ namespace: topology.namespace, queues, ownerIds: owners, cleaned }, null, 2)); save();
  const connection = await connect(config.rabbitmqUrl, { timeout: 5_000 }); connection.on('error', () => {});
  const channel = await connection.createChannel(); channel.on('error', () => {});
  const existing = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin(['list_queues','-p','resume-studio-s12-test','name','--formatter','json']));
  assert.ok(queues.every(name => !existing.some(item => item.name === name)));
  t.after(async () => {
    try {
      await ownedRabbit(); await ownedPostgres();
      const cleanupConnection = await connect(config.rabbitmqUrl, { timeout: 5_000 }); cleanupConnection.on('error', () => {});
      try {
        const cleanup = await cleanupConnection.createChannel(); cleanup.on('error', () => {});
        for (const queue of queues) await cleanup.deleteQueue(queue);
        await cleanup.deleteExchange(topology.exchange); await cleanup.deleteExchange(topology.deadExchange);
      } finally { await cleanupConnection.close(); }
      await rabbitAdmin(['clear_policy','-p','resume-studio-s12-test',topology.policy]);
      for (const ownerId of owners) {
        await db.$transaction(async tx => {
          await tx.consumerReceipt.deleteMany({ where: { ownerId } }); await tx.taskEvent.deleteMany({ where: { ownerId } });
          await tx.taskAttempt.deleteMany({ where: { ownerId } }); await tx.outboxEvent.deleteMany({ where: { ownerId } });
          await tx.analysisTask.deleteMany({ where: { ownerId } }); await tx.jobIndexTask.deleteMany({ where: { ownerId } });
          await tx.owner.delete({ where: { id: ownerId } });
        });
        for (const count of await Promise.all([db.owner.count({ where: { id: ownerId } }), db.outboxEvent.count({ where: { ownerId } }),
          db.taskEvent.count({ where: { ownerId } }), db.taskAttempt.count({ where: { ownerId } }), db.consumerReceipt.count({ where: { ownerId } }),
          db.analysisTask.count({ where: { ownerId } }), db.jobIndexTask.count({ where: { ownerId } })])) assert.equal(count, 0);
      }
      const remaining = z.array(z.object({ name: z.string() })).parse(await rabbitAdmin(['list_queues','-p','resume-studio-s12-test','name','--formatter','json']));
      assert.ok(remaining.every(item => !queues.includes(item.name))); save(true);
      t.diagnostic('T6 exact-run owners/tasks/events/receipts/outbox/queues/policy removed; no shared resources deleted');
    } finally { await channel.close().catch(() => {}); await connection.close().catch(() => {}); await database.onModuleDestroy(); assert.equal(database.pool.totalCount, 0); }
  });
  t.afterEach(async () => {
    for (const queue of queues) for (let index = 0; index < 20; index++) {
      const message = await channel.get(queue, { noAck: false }); if (!message) break; channel.ack(message);
    }
  });
  await installTaskPolicy(topology); await declareTaskTopology(channel, topology);
  const execution = consumerConfigSchema.parse({}), reconciliation = reconciliationConfigSchema.parse({ staleMs: 1000 });
  const store = new TaskExecutionStore(database, execution), scan = new ReconciliationStore(database);
  const lock = new PostgresExecutionLock(database.pool), delivery = outboxConfigSchema.parse({});
  const transport = new ConfirmedTaskPublisher(config.rabbitmqUrl, topology, 5_000);
  async function context(type: TaskType, budget: Partial<ReturnType<typeof analysisInput>['budget']> = {}) {
    const ownerId = randomUUID(); await db.owner.create({ data: { id: ownerId } }); owners.push(ownerId); save();
    const identity = { getOwnerId: () => Promise.resolve(ownerId) }, tasks = new TaskCreationService(identity, new TaskRepository(database));
    const input = type === 'analysis' ? analysisInput() : jobIndexInput(); input.budget = { ...input.budget, maxDurationMs: 300000, ...budget };
    const task = type === 'analysis' ? await tasks.createAnalysis(randomUUID(), input) : await tasks.createJobIndex(randomUUID(), input);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: task.taskId } });
    const message = taskDispatchSchema.parse(event.payload);
    const publisher = new OutboxPublisher(new OutboxStore(database, delivery), transport, identity, delivery);
    const service = new ReconciliationService(scan, store, publisher, identity, reconciliation);
    const handler = new TaskDeliveryHandler(store, identity, new SyntheticCompletionHandler(), execution, lock);
    const consumer = new TaskConsumer(config.rabbitmqUrl, topology, handler);
    const read = () => type === 'analysis' ? db.analysisTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: task.taskId } } })
      : db.jobIndexTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: task.taskId } } });
    const table = type === 'analysis' ? 'analysis_task' : 'job_index_task';
    return { ownerId, identity, taskId: task.taskId, event, message, publisher, service, handler, consumer, read, table,
      queue: type === 'analysis' ? topology.analysis : topology.jobIndex };
  }
  async function age(c: Awaited<ReturnType<typeof context>>) {
    await database.pool.query(`UPDATE ${c.table} SET updated_at=clock_timestamp()-interval '10 seconds' WHERE owner_id=$1::uuid AND id=$2::uuid`, [c.ownerId, c.taskId]);
  }
  async function expire(c: Awaited<ReturnType<typeof context>>) {
    await database.pool.query(`UPDATE ${c.table} SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=$1::uuid AND id=$2::uuid`, [c.ownerId, c.taskId]);
  }
  for (const type of ['analysis','job-index'] as const) {
    await t.test(`${type}: expired RUNNING atomically recovers once, rejects old fence and actually completes via broker`, async () => {
      const c = await context(type), acquired = await store.claim(c.ownerId, c.message);
      assert.equal(acquired.kind, 'acquired'); if (acquired.kind !== 'acquired') return;
      await expire(c);
      const outcomes = await Promise.all([store.reconcile(c.ownerId, type, c.taskId, reconciliation), store.reconcile(c.ownerId, type, c.taskId, reconciliation)]);
      assert.equal(outcomes.filter(value => value === 'recovered').length, 1);
      const recovered = await c.read(); assert.equal(recovered.status, 'QUEUED'); assert.equal(recovered.generation, 2);
      assert.equal(recovered.fenceToken, 2n); assert.equal(recovered.recoveryCount, 1); assert.deepEqual(recovered.inputSnapshot, acquired.claim.snapshot);
      assert.equal((await db.consumerReceipt.findFirstOrThrow({ where: { ownerId: c.ownerId } })).status, 'DONE');
      assert.equal((await db.taskAttempt.findFirstOrThrow({ where: { ownerId: c.ownerId } })).errorClass, 'LEASE_EXPIRED');
      assert.equal(budgetUsageSchema.parse(recovered.budgetUsage).attempts, 1);
      await assert.rejects(store.heartbeat(acquired.claim), /LEASE_LOST/);
      await assert.rejects(store.complete(acquired.claim, await new SyntheticCompletionHandler().execute(acquired.claim, new AbortController().signal)), /LEASE_LOST/);
      const cycle = await c.service.runOnce(); assert.equal(cycle.publications.filter(value => value === 'published').length, 2);
      assert.equal((await c.consumer.run(type, { maxMessages: 2, windowMs: 10_000 })).acknowledged, 2);
      assert.equal((await c.read()).status, 'SUCCEEDED'); assert.equal(await db.taskAttempt.count({ where: { ownerId: c.ownerId } }), 2);
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId, stage: 'SYNTHETIC_COMPLETED' } }), 1);
    });
  }

  await t.test('live process holding session lock is never preempted despite expired lease; after SIGKILL recovery succeeds', async () => {
    const c = await context('analysis');
    const child = fork(new URL('./reconciliation-worker.fixture.js', import.meta.url), [], { silent: true,
      env: { ...process.env, S16_OWNER_ID: c.ownerId, S16_MESSAGE: JSON.stringify(c.message) } });
    child.stdout?.resume(); child.stderr?.resume(); const exit = once(child, 'exit');
    try {
      const response = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error('Worker exited before lock'); }),
        delay(15000, undefined, { ref: false }).then(() => { throw new Error('Worker lock IPC timeout'); })]);
      assert.deepEqual(response[0], { type: 'executing-with-lock' }); await expire(c);
      const before = await c.read();
      assert.equal(await store.reconcile(c.ownerId, 'analysis', c.taskId, reconciliation), 'lock-held');
      assert.equal(await c.handler.handle(c.message, new AbortController().signal), 'deferred');
      const after = await c.read(); assert.equal(after.fenceToken, before.fenceToken); assert.equal(after.generation, before.generation);
      assert.equal(after.recoveryCount, 0); assert.equal(await db.outboxEvent.count({ where: { ownerId: c.ownerId } }), 1);
      child.kill('SIGKILL'); await exit;
      assert.equal(await store.reconcile(c.ownerId, 'analysis', c.taskId, reconciliation), 'recovered');
      await c.service.runOnce(); assert.equal((await c.consumer.run('analysis', { maxMessages: 2, windowMs: 10000 })).acknowledged, 2);
      assert.equal((await c.read()).status, 'SUCCEEDED');
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
  });

  await t.test('session loss aborts actual handler and releases lock; pool connections are not returned with leaked locks', async () => {
    const c = await context('analysis'), name = `s16-lock-${randomUUID()}`;
    const lockPool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 3000,
      statement_timeout: 5000, application_name: name }); lockPool.on('error', () => {});
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const locks = new PostgresExecutionLock(lockPool);
    const handler = new TaskDeliveryHandler(store, c.identity, { execute: async (claim, signal) => {
      started(); await delay(10000, undefined, { signal }); return new SyntheticCompletionHandler().execute(claim, signal);
    } }, execution, locks);
    const work = handler.handle(c.message, new AbortController().signal), rejected = assert.rejects(work);
    try {
      await ready;
      const pid = z.array(z.object({ pid: z.number() })).length(1).parse((await database.pool.query(
        'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND usename=current_user', [name])).rows)[0]!.pid;
      await database.pool.query('SELECT pg_terminate_backend($1::int)', [pid]); await rejected;
      assert.equal(await db.taskEvent.count({ where: { ownerId: c.ownerId } }), 0);
      assert.equal(await locks.run(c.ownerId, 'analysis', c.taskId, new AbortController().signal, () => Promise.resolve('fresh')), 'fresh');
      assert.equal(await lock.run(c.ownerId, 'analysis', c.taskId, new AbortController().signal, () => Promise.resolve('released')), 'released');
    } finally { await lockPool.end(); }
  });

  await t.test('row locks, valid leases, cancellation, future retries and other owners remain unchanged', async () => {
    const c = await context('job-index'); await store.claim(c.ownerId, c.message);
    assert.equal(await store.reconcile(c.ownerId, 'job-index', c.taskId, reconciliation), 'skipped');
    await expire(c); const session = await database.pool.connect();
    try {
      await session.query('BEGIN'); await session.query('SELECT id FROM job_index_task WHERE owner_id=$1::uuid AND id=$2::uuid FOR UPDATE', [c.ownerId,c.taskId]);
      assert.equal(await store.reconcile(c.ownerId, 'job-index', c.taskId, reconciliation), 'skipped');
    } finally { await session.query('ROLLBACK'); session.release(); }
    assert.equal(await store.reconcile(randomUUID(), 'job-index', c.taskId, reconciliation), 'skipped');
    await db.jobIndexTask.update({ where: { ownerId_id: { ownerId:c.ownerId, id:c.taskId } }, data:{cancelRequested:true} });
    assert.equal(await store.reconcile(c.ownerId, 'job-index', c.taskId, reconciliation), 'skipped');
    const future = await context('analysis');
    await db.analysisTask.update({ where: {ownerId_id:{ownerId:future.ownerId,id:future.taskId}}, data:{status:'RETRY_WAIT',retryAt:new Date(Date.now()+60000)} });
    await age(future); assert.equal(await store.reconcile(future.ownerId,'analysis',future.taskId,reconciliation),'skipped');
  });

  await t.test('pending events use original publisher budgets and expired publish leases; failed events are reported without resetting', async () => {
    const c = await context('analysis'); await age(c);
    assert.equal(await store.reconcile(c.ownerId,'analysis',c.taskId,reconciliation),'pending');
    await db.outboxEvent.update({where:{eventId:c.event.eventId,ownerId:c.ownerId},data:{leaseOwner:randomUUID(),leaseUntil:new Date(Date.now()+60000),publishAttempts:2}});
    let result = await c.service.runOnce(); assert.deepEqual(result.publications,['idle']); assert.equal(result.outbox?.pending,1);
    await db.outboxEvent.update({where:{eventId:c.event.eventId,ownerId:c.ownerId},data:{leaseUntil:new Date(0)}});
    result = await c.service.runOnce(); assert.deepEqual(result.publications,['published','idle']);
    assert.equal((await db.outboxEvent.findUniqueOrThrow({where:{eventId:c.event.eventId,ownerId:c.ownerId}})).publishAttempts,3);
    assert.equal((await c.read()).generation,1);
    const failed = await context('job-index'); await age(failed);
    await db.outboxEvent.update({where:{eventId:failed.event.eventId,ownerId:failed.ownerId},data:{failedAt:new Date(),publishAttempts:8,lastErrorCode:'PUBLISH_BUDGET_EXHAUSTED'}});
    result = await failed.service.runOnce(); assert.ok(result.tasks.includes('delivery-failed')); assert.equal(result.outbox?.failed,1);
    assert.equal(await db.outboxEvent.count({where:{ownerId:failed.ownerId}}),1); assert.equal((await failed.read()).generation,1);
  });

  await t.test('missing dispatch and old confirmed/no-terminal tasks are rescheduled once with bounded recovery count', async () => {
    const missing=await context('analysis');await db.outboxEvent.delete({where:{eventId:missing.event.eventId,ownerId:missing.ownerId}});await age(missing);
    assert.equal(await store.reconcile(missing.ownerId,'analysis',missing.taskId,reconciliation),'recovered');
    assert.equal(await store.reconcile(missing.ownerId,'analysis',missing.taskId,reconciliation),'skipped');
    const c=await context('job-index'), limited=reconciliationConfigSchema.parse({...reconciliation,maxRecoveries:1}); await age(c);
    await db.outboxEvent.update({where:{eventId:c.event.eventId,ownerId:c.ownerId},data:{publishedAt:new Date(Date.now()-10000)}});
    assert.equal(await store.reconcile(c.ownerId,'job-index',c.taskId,limited),'recovered'); await age(c);
    assert.equal(await store.reconcile(c.ownerId,'job-index',c.taskId,limited),'pending');
    await db.outboxEvent.updateMany({where:{ownerId:c.ownerId,publishedAt:null},data:{publishedAt:new Date(Date.now()-10000)}});
    assert.equal(await store.reconcile(c.ownerId,'job-index',c.taskId,limited),'failed');
    assert.equal((await c.read()).status,'FAILED'); assert.equal((await c.read()).recoveryCount,1);
    const dead=await db.outboxEvent.findFirstOrThrow({where:{ownerId:c.ownerId,eventType:'job.index.dead.v1'}});
    assert.equal(deadMessageSchema.parse(dead.payload).errorCode,'BUDGET_EXHAUSTED');
    assert.equal(await store.reconcile(c.ownerId,'job-index',c.taskId,limited),'skipped');
    const orphan=await context('analysis');await db.outboxEvent.delete({where:{eventId:orphan.event.eventId,ownerId:orphan.ownerId}});
    await db.analysisTask.update({where:{ownerId_id:{ownerId:orphan.ownerId,id:orphan.taskId}},data:{recoveryCount:3}});await age(orphan);
    assert.equal(await store.reconcile(orphan.ownerId,'analysis',orphan.taskId,reconciliation),'failed');
    assert.equal(await db.consumerReceipt.count({where:{ownerId:orphan.ownerId}}),0);
    const orphanDead=await db.outboxEvent.findFirstOrThrow({where:{ownerId:orphan.ownerId,eventType:'analysis.dead.v1'}});
    assert.equal(deadMessageSchema.parse(orphanDead.payload).originalMessageId,null);
  });

  await t.test('expired final attempt is terminalized through the T5 dead transaction without a new attempt',async()=>{
    const c=await context('analysis',{maxAttempts:1});await store.claim(c.ownerId,c.message);await expire(c);
    assert.equal(await store.reconcile(c.ownerId,'analysis',c.taskId,reconciliation),'failed');
    assert.equal((await c.read()).status,'FAILED');assert.equal(await db.taskAttempt.count({where:{ownerId:c.ownerId}}),1);
    assert.equal(await db.outboxEvent.count({where:{ownerId:c.ownerId,eventType:'analysis.dead.v1'}}),1);
  });

  await t.test('recovery SQL failure rolls back fencing, attempt/receipt state and output; read-only database cannot repair',async()=>{
    const c=await context('analysis');await store.claim(c.ownerId,c.message);await expire(c);
    const broken:TransactionDatabase={client:{$transaction:work=>db.$transaction(tx=>work(new Proxy(tx,{get(target,key,receiver){
      if(key!=='outboxEvent')return Reflect.get(target,key,receiver);
      return new Proxy(target.outboxEvent,{get(model,method,r){if(method!=='create')return Reflect.get(model,method,r);
        return(args:Prisma.OutboxEventCreateArgs)=>model.create({...args,data:{...args.data,payloadVersion:0}});}});
    }})))}};
    await assert.rejects(new TaskExecutionStore(broken,execution).reconcile(c.ownerId,'analysis',c.taskId,reconciliation));
    const row=await c.read();assert.equal(row.status,'RUNNING');assert.equal(row.generation,1);assert.equal(row.fenceToken,1n);assert.equal(row.recoveryCount,0);
    assert.equal((await db.taskAttempt.findFirstOrThrow({where:{ownerId:c.ownerId}})).endedAt,null);
    assert.equal((await db.consumerReceipt.findFirstOrThrow({where:{ownerId:c.ownerId}})).status,'RUNNING');
    assert.equal(await db.taskEvent.count({where:{ownerId:c.ownerId}}),0);assert.equal(await db.outboxEvent.count({where:{ownerId:c.ownerId}}),1);
    const url=new URL(config.databaseUrl);url.searchParams.set('options','-c default_transaction_read_only=on');const readonly=new DatabaseService({databaseUrl:url.toString()});
    try{await assert.rejects(new TaskExecutionStore(readonly,execution).reconcile(c.ownerId,'analysis',c.taskId,reconciliation));}finally{await readonly.onModuleDestroy();}
    assert.equal(await store.reconcile(c.ownerId,'analysis',c.taskId,reconciliation),'recovered');
  });

  await t.test('candidate paging covers later held tasks without exceeding page limit or crossing owners',async()=>{
    const c=await context('analysis');await age(c);
    const tasks=new TaskCreationService(c.identity,new TaskRepository(database));const second=await tasks.createAnalysis(randomUUID(),analysisInput());
    await database.pool.query("UPDATE analysis_task SET updated_at=now()-interval '10 seconds' WHERE owner_id=$1::uuid",[c.ownerId]);
    const firstPage=await scan.candidates(c.ownerId,'analysis',undefined,1,1000);assert.equal(firstPage.length,1);
    const secondPage=await scan.candidates(c.ownerId,'analysis',firstPage[0],1,1000);assert.equal(secondPage.length,1);
    assert.deepEqual(new Set([...firstPage,...secondPage]),new Set([c.taskId,second.taskId]));
    assert.deepEqual(await scan.candidates(randomUUID(),'analysis',undefined,10,1000),[]);
    const session=await database.pool.connect();
    try{await session.query('SELECT pg_advisory_lock($1::bigint)',[executionLockKey(c.ownerId,'analysis',firstPage[0]!)]);
      assert.equal(await store.reconcile(c.ownerId,'analysis',firstPage[0]!,reconciliation),'lock-held');
    }finally{session.release(true);}
  });
});
