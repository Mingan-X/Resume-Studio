import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {DatabaseService} from '../database/database.service.js';
import {LifecycleRepository} from './lifecycle.repository.js';
import {deletionResourceSchema} from '../../contracts/lifecycle.js';
import type {DeletionResource} from '../../contracts/lifecycle.js';
import {TaskExecutionStore} from '../consumer/task-execution.store.js';
import {consumerConfigSchema} from '../consumer/config.js';
import {reconciliationConfigSchema} from '../reconciliation/config.js';

export interface DeletionStorage {erase(resource:DeletionResource,signal:AbortSignal,deadline:number):Promise<void>;}
export class LifecycleExecutor {
 constructor(private readonly database:DatabaseService,private readonly storage:DeletionStorage){}
 async run(id:string,signal:AbortSignal=new AbortController().signal){
  z.uuid().parse(id);const deadline=Date.now()+60000,lost=new AbortController(),abort=AbortSignal.any([signal,lost.signal,AbortSignal.timeout(60000)]);
  const request=await this.database.client.deletionRequest.findUniqueOrThrow({where:{id}}),lockKey=request.ownerId;
  const connection=await this.database.pool.connect();let acquired=false;
  const disconnected=()=>lost.abort();connection.on('error',disconnected);connection.on('end',disconnected);
  try{
   const result=await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1,7326)) AS acquired',[lockKey]);
   acquired=z.array(z.object({acquired:z.boolean()})).parse(result.rows)[0]!.acquired;if(!acquired)return 'busy';
   await this.database.client.deletionRequest.update({where:{id},data:{checkedAt:new Date()}});
   const repo=new LifecycleRepository(this.database);
   if(request.status==='DONE')return 'done';
   if(request.scope==='ALL'){
    // The barrier is already committed. Avoid holding its owner lock while waiting
    // for a worker task row whose completion may itself need the shared owner lock.
    await this.database.client.analysisTask.updateMany({where:{ownerId:request.ownerId,status:{in:['QUEUED','RETRY_WAIT','RUNNING']}},data:{cancelRequested:true}});
    await this.database.client.jobIndexTask.updateMany({where:{ownerId:request.ownerId,status:{in:['QUEUED','RETRY_WAIT','RUNNING']}},data:{cancelRequested:true}});
    const tasks=new TaskExecutionStore(this.database,consumerConfigSchema.parse({})),policy=reconciliationConfigSchema.parse({});
    const analyses=await this.database.client.analysisTask.findMany({where:{ownerId:request.ownerId,cancelRequested:true,status:{in:['QUEUED','RETRY_WAIT','RUNNING']}},take:100});
    const indexes=await this.database.client.jobIndexTask.findMany({where:{ownerId:request.ownerId,cancelRequested:true,status:{in:['QUEUED','RETRY_WAIT','RUNNING']}},take:100});
    for(const task of analyses){abort.throwIfAborted();await tasks.reconcile(request.ownerId,'analysis',task.id,policy);}
    for(const task of indexes){abort.throwIfAborted();await tasks.reconcile(request.ownerId,'job-index',task.id,policy);}
   }
   abort.throwIfAborted();const state=await repo.prepare(id);if(state!=='ready')return state;
   const steps=await this.database.client.deletionStep.findMany({where:{requestId:id,completedAt:null},orderBy:{id:'asc'},take:100});
   for(const step of steps){
    abort.throwIfAborted();if(Date.now()>=deadline)break;
    if(step.attempts>=5){await this.database.client.deletionRequest.update({where:{id},data:{reason:'RETRY_LIMIT'}});return 'waiting';}
    if(step.retryAt&&step.retryAt>new Date())continue;
    const resource=deletionResourceSchema.parse(step.resource),ownerId=request.ownerId;
    if(resource.kind==='VECTOR'&&(request.scope!=='ALL'||resource.ownerId!==ownerId))throw new Error('DELETE_RESOURCE_OWNER');
    if(resource.kind==='FILE'&&!await this.database.client.fileAsset.findFirst({where:{ownerId,storageKey:resource.storageKey,sha256:resource.sha256,size:resource.size,
      ...(request.scope==='RESUME'?{versions:{some:{id:request.resumeVersionId!}}}:{})}}))throw new Error('DELETE_RESOURCE_OWNER');
    if(resource.kind==='CHECKPOINT'&&!await this.database.client.taskCheckpointThread.findFirst({where:{ownerId,threadId:resource.threadId,
      ...(request.scope==='RESUME'?{task:{realResumeVersionId:request.resumeVersionId}}:{})}}))throw new Error('DELETE_RESOURCE_OWNER');
    if(resource.kind==='TRACE'&&!await this.database.client.resourceTrace.findFirst({where:{ownerId,traceId:resource.traceId}}))throw new Error('DELETE_RESOURCE_OWNER');
    await this.database.client.deletionStep.update({where:{id:step.id},data:{attempts:{increment:1}}});
    try{await this.storage.erase(resource,abort,deadline);
     await this.database.client.deletionStep.update({where:{id:step.id},data:{completedAt:new Date(),retryAt:null}});
    }catch{
     const resource=deletionResourceSchema.parse(step.resource),wait=resource.kind==='TRACE'?300000:Math.min(60000,1000*2**step.attempts);
     await this.database.client.deletionStep.update({where:{id:step.id},data:{retryAt:new Date(Date.now()+wait*(0.5+Math.random()/2))}});
     await this.database.client.deletionRequest.update({where:{id},data:{reason:'STORAGE_UNAVAILABLE'}});return 'waiting';
    }
   }
   if(await this.database.client.deletionStep.count({where:{requestId:id,completedAt:null}}))return 'waiting';
   abort.throwIfAborted();await repo.eraseBusiness(id);return 'done';
  }finally{let discard=lost.signal.aborted;try{if(acquired&&!discard)await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,7326))',[lockKey]);}catch{discard=true;}
   connection.off('error',disconnected);connection.off('end',disconnected);connection.release(discard);}
 }
 async once(signal:AbortSignal){const deadline=Date.now()+60000,cycle=AbortSignal.any([signal,AbortSignal.timeout(60000)]),repo=new LifecycleRepository(this.database);await repo.due(20,cycle);
  cycle.throwIfAborted();
  const requests=await this.database.client.deletionRequest.findMany({where:{status:{not:'DONE'},OR:[{reason:null},{reason:{not:'RETRY_LIMIT'}}]},orderBy:{checkedAt:'asc'},take:20});
  const results:Record<string,number>={};for(const request of requests){if(cycle.aborted||Date.now()>=deadline)break;
   const outcome=await this.run(request.id,cycle);results[outcome]=(results[outcome]??0)+1;
  }return {runId:randomUUID(),results};
 }
}
