import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseService} from '../../src/infrastructure/database/database.service.js';
import {loadInfrastructureConfig} from '../../src/infrastructure/config.js';
import {ownedPostgres} from '../../src/infrastructure/checkpoint/ownership.js';
import {loadCheckpointConfig} from '../../src/infrastructure/checkpoint/config.js';
import {loadObservabilityConfig} from '../../src/infrastructure/observability/config.js';
import {ObservabilityService} from '../../src/infrastructure/observability/observability.module.js';
import {assertObservabilityOwnership} from '../../src/infrastructure/observability/ownership.js';
import {LifecycleRepository} from '../../src/infrastructure/tasks/lifecycle.repository.js';
import {LifecycleStorage} from '../../src/infrastructure/tasks/lifecycle.storage.js';
import {LocalStorage} from '../../src/infrastructure/storage/local-storage.js';
import {JobIndexVector} from '../../src/infrastructure/vector/job-index.vector.js';
import {ownedQdrant} from '../../src/infrastructure/vector/ownership.js';
await test('S3.2 real Langfuse trace registry waits for ingestion then confirms asynchronous deletion',{timeout:180000},async t=>{
 await ownedPostgres();await assertObservabilityOwnership(true);const config=loadInfrastructureConfig(process.env),observation=loadObservabilityConfig(process.env);assert.ok(observation.enabled);
 const database=new DatabaseService(config),repo=new LifecycleRepository(database),owner=randomUUID(),service=new ObservabilityService(observation);
 const root=await mkdtemp(join(tmpdir(),'resume-trace-delete-'));let traceId:string|undefined,deleted=false;
 const storage=new LifecycleStorage(await LocalStorage.create(root),new JobIndexVector({url:config.qdrantUrl,apiKey:config.qdrantApiKey},ownedQdrant),loadCheckpointConfig(process.env),observation,database);
 await database.client.owner.create({data:{id:owner}});
 t.after(async()=>{try{await service.onModuleDestroy();if(traceId&&!deleted){await assertObservabilityOwnership();const response=await fetch(`${observation.baseUrl}/api/public/traces/${traceId}`,{method:'DELETE',headers:{Authorization:`Basic ${Buffer.from(`${observation.publicKey}:${observation.secretKey}`).toString('base64')}`},signal:AbortSignal.timeout(10000)});await response.body?.cancel();}
  await ownedPostgres();await database.client.owner.delete({where:{id:owner}});
 }finally{await database.onModuleDestroy();assert.ok(!relative(resolve(tmpdir()),resolve(root)).startsWith('..'));await rm(root,{recursive:true});}});
 assert.equal(await service.run(randomUUID(),'observation',async()=>42,async id=>{traceId=id;await repo.trace(owner,id);}),42);assert.ok(traceId);
 const deadline=Date.now()+120000;let last='';
 while(Date.now()<deadline){
  try{await storage.erase({kind:'TRACE',traceId},t.signal,Math.min(deadline,Date.now()+30000));deleted=true;break;}
  catch(error){last=error instanceof Error?error.message:'UNKNOWN';if(!['TRACE_NOT_YET_OBSERVED','TRACE_DELETE_PENDING'].includes(last))throw error;await delay(2000,undefined,{signal:t.signal});}
 }
 assert.ok(deleted,`Trace deletion confirmation incomplete: ${last}`);
 const row=await database.client.resourceTrace.findUniqueOrThrow({where:{traceId}});assert.ok(row.observedAt&&row.deleteRequestedAt);
});
