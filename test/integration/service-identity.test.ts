import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {DatabaseService} from '../../src/infrastructure/database/database.service.js';
import {loadInfrastructureConfig} from '../../src/infrastructure/config.js';
import {ownedPostgres} from '../../src/infrastructure/checkpoint/ownership.js';
import {AuthRepository} from '../../src/infrastructure/tasks/auth.repository.js';
import {TaskRepository} from '../../src/infrastructure/tasks/task.repository.js';
import {TaskCreationService} from '../../src/modules/tasks/task-creation.service.js';
import {TaskExecutionStore} from '../../src/infrastructure/consumer/task-execution.store.js';
import {TaskDeliveryHandler,SyntheticCompletionHandler} from '../../src/infrastructure/consumer/task-delivery.handler.js';
import {PostgresExecutionLock} from '../../src/infrastructure/consumer/task-execution.lock.js';
import {consumerConfigSchema} from '../../src/infrastructure/consumer/config.js';
import {PersistedDeliveryRouter,ServiceIdentity,configuredServiceOwner} from '../../src/infrastructure/consumer/service-identity.js';
import {DEVELOPMENT_OWNER_ID} from '../../src/modules/identity/identity.module.js';
import {taskDispatchSchema} from '../../src/contracts/tasks.js';
import {analysisInput} from '../support/task-inputs.js';

await test('S3.2 shared worker resolves owners from durable dispatches, rejects forgery and keeps concurrent contexts separate',{timeout:60000},async t=>{
  await ownedPostgres();const database=new DatabaseService(loadInfrastructureConfig(process.env)),db=database.client,owners:string[]=[];
  t.after(async()=>{try{await ownedPostgres();await db.$transaction(async tx=>{
    const where={ownerId:{in:owners}};await tx.consumerReceipt.deleteMany({where});await tx.taskEvent.deleteMany({where});await tx.taskAttempt.deleteMany({where});
    await tx.outboxEvent.deleteMany({where});await tx.analysisTask.deleteMany({where});await tx.account.deleteMany({where});await tx.owner.deleteMany({where:{id:{in:owners}}});
  });}finally{await database.onModuleDestroy();}});
  const identity=new ServiceIdentity(),execution=consumerConfigSchema.parse({}),store=new TaskExecutionStore(database,execution);
  const router=new PersistedDeliveryRouter(database,identity,new TaskDeliveryHandler(store,identity,new SyntheticCompletionHandler(),execution,new PostgresExecutionLock(database.pool)),true);
  const make=async()=>{
    const account=await new AuthRepository(database).createAccount(`worker-${randomUUID()}`,'synthetic-worker-password-123');owners.push(account.ownerId);
    const task=await new TaskCreationService({getOwnerId:()=>Promise.resolve(account.ownerId)},new TaskRepository(database)).createAnalysis(randomUUID(),analysisInput());
    const event=await db.outboxEvent.findFirstOrThrow({where:{ownerId:account.ownerId,aggregateId:task.taskId}});
    return {account,task,message:taskDispatchSchema.parse(event.payload)};
  };
  const a=await make(),b=await make(),signal=new AbortController().signal;
  assert.throws(()=>identity.getOwnerId(),/TRUSTED_OWNER/);
  await assert.rejects(router.handle({...a.message,taskId:b.task.taskId},signal),/MESSAGE_ID_REUSED/);
  await assert.rejects(router.handle({...a.message,messageId:randomUUID()},signal),/TASK_NOT_AVAILABLE/);
  assert.deepEqual(await Promise.all([router.handle(a.message,signal),router.handle(b.message,signal)]),['ack','ack']);
  for(const value of [a,b])assert.equal((await db.analysisTask.findUniqueOrThrow({where:{id:value.task.taskId}})).status,'SUCCEEDED');
  assert.equal(await configuredServiceOwner(database,{APP_ENV:'production',SERVICE_OWNER_ID:a.account.ownerId}),a.account.ownerId);
  await assert.rejects(configuredServiceOwner(database,{APP_ENV:'production'}),/SERVICE_OWNER_REQUIRED/);
  await assert.rejects(configuredServiceOwner(database,{APP_ENV:'production',SERVICE_OWNER_ID:DEVELOPMENT_OWNER_ID}),/DEVELOPMENT_IDENTITY_FORBIDDEN/);
  await db.account.update({where:{id:a.account.id},data:{enabled:false}});
  assert.equal(await router.handle(a.message,signal),'deferred');
  await assert.rejects(configuredServiceOwner(database,{APP_ENV:'production',SERVICE_OWNER_ID:a.account.ownerId}),/SERVICE_OWNER_NOT_AVAILABLE/);
  assert.throws(()=>identity.getOwnerId(),/TRUSTED_OWNER/);
});
