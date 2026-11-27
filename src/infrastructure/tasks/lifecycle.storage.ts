import {z} from 'zod';
import type {DeletionResource} from '../../contracts/lifecycle.js';
import type {DeletionStorage} from './lifecycle.executor.js';
import type {LocalStorage} from '../storage/local-storage.js';
import type {JobIndexVector} from '../vector/job-index.vector.js';
import type {CheckpointConfig} from '../checkpoint/config.js';
import {createCheckpointStore} from '../checkpoint/store.js';
import {ownedPostgres} from '../checkpoint/ownership.js';
import {assertObservabilityOwnership} from '../observability/ownership.js';
import type {DatabaseService} from '../database/database.service.js';

export class LifecycleStorage implements DeletionStorage{
 constructor(private readonly files:LocalStorage,private readonly vectors:JobIndexVector,private readonly checkpoint:CheckpointConfig,
  private readonly traces:{baseUrl:string;publicKey:string;secretKey:string},private readonly database?:DatabaseService){}
 async erase(resource:DeletionResource,signal:AbortSignal,deadline:number){
  signal.throwIfAborted();if(Date.now()>=deadline)throw new Error('DELETION_DEADLINE');
  if(resource.kind==='FILE'){await this.files.eraseOwned(resource.storageKey,resource.sha256,resource.size,signal);return;}
  if(resource.kind==='VECTOR'){await this.vectors.eraseOwner(resource.ownerId,{signal,deadline});return;}
  if(resource.kind==='CHECKPOINT'){
   await ownedPostgres(signal);signal.throwIfAborted();const session=createCheckpointStore(this.checkpoint);
   try{await session.saver.deleteThread(resource.threadId);if(await session.saver.getTuple({configurable:{thread_id:resource.threadId}}))throw new Error('CHECKPOINT_DELETE_PENDING');}
   finally{await session.close();}return;
  }
  await assertObservabilityOwnership(false,signal);signal.throwIfAborted();
  const headers={Authorization:`Basic ${Buffer.from(`${this.traces.publicKey}:${this.traces.secretKey}`).toString('base64')}`};
  const request=async(path:string,method='GET')=>{
   const remaining=deadline-Date.now();if(remaining<=0)throw new Error('DELETION_DEADLINE');
   return fetch(new URL(path,this.traces.baseUrl),{method,headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(Math.min(10000,remaining))])});
  };
  const projects=await request('/api/public/projects');if(!projects.ok)throw new Error('TRACE_UNAVAILABLE');
  const list=z.object({data:z.array(z.object({id:z.string()}))}).parse(await projects.json());
  if(list.data.length!==1||list.data[0]?.id!=='resume-studio-diagnostics')throw new Error('TRACE_PROJECT_MISMATCH');
  if(!this.database)throw new Error('TRACE_REGISTRY_REQUIRED');
  const registered=await this.database.client.resourceTrace.findUniqueOrThrow({where:{traceId:resource.traceId}});
  const observations=`/api/public/v2/observations?traceId=${resource.traceId}&fields=core&limit=1`;
  const visible=await request(observations);if(!visible.ok)throw new Error('TRACE_READ_FAILED');
  const rows=z.object({data:z.array(z.object({traceId:z.literal(resource.traceId)}))}).parse(await visible.json());
  // An empty async read before ingestion is not proof of deletion. Persist prior
  // visibility and submission separately, so a crash between these steps can resume.
  if(!rows.data.length){if(registered.observedAt&&registered.deleteRequestedAt)return;throw new Error('TRACE_NOT_YET_OBSERVED');}
  if(!registered.observedAt)await this.database.client.resourceTrace.update({where:{traceId:resource.traceId},data:{observedAt:new Date()}});
  const path=`/api/public/traces/${resource.traceId}`,deleted=await request(path,'DELETE');
  if(!deleted.ok&&deleted.status!==404)throw new Error('TRACE_DELETE_FAILED');await deleted.body?.cancel();
  await this.database.client.resourceTrace.update({where:{traceId:resource.traceId},data:{deleteRequestedAt:new Date()}});
  const verify=await request(observations);if(!verify.ok)throw new Error('TRACE_READ_FAILED');
  if(z.object({data:z.array(z.unknown())}).parse(await verify.json()).data.length)throw new Error('TRACE_DELETE_PENDING');
 }
}
