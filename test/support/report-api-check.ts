import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Test} from '@nestjs/testing';
import {ApiModule} from '../../src/app-api.module.js';
import {TaskApiModule} from '../../src/modules/tasks/task-api.module.js';
import {configureHttp} from '../../src/bootstrap-api.js';
import {loadConfig} from '../../src/modules/config/app-config.js';
import {IDENTITY} from '../../src/modules/identity/identity.module.js';
import type {DatabaseService} from '../../src/infrastructure/database/database.service.js';
import {reportResponseSchema,reportListSchema} from '../../src/contracts/reports.js';
import {analysisListSchema,analysisDetailSchema,analysisOptionsSchema} from '../../src/contracts/analysis-api.js';
import {TaskRepository} from '../../src/infrastructure/tasks/task.repository.js';
import {analysisInput} from './task-inputs.js';
import {defaultScoringPolicy} from '../../src/modules/scoring/default-policy.js';
import {budgetUsageSchema} from '../../src/contracts/tasks.js';

export async function verifyReportApi(database:DatabaseService,databaseUrl:string,owner:string,reportId:string,taskId:string){
 let ownerId=owner;
 const open=async()=>{const module=await Test.createTestingModule({imports:[ApiModule.register(loadConfig('api',{APP_ENV:'test',HTTP_PORT:'3000'}),[TaskApiModule.register({databaseUrl})])]}).overrideProvider(IDENTITY).useValue({getOwnerId:async()=>ownerId}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');return app;};
 let app=await open();
 try{
  let base=await app.getUrl();const original=reportResponseSchema.parse(await(await fetch(`${base}/api/v1/reports/${reportId}`)).json());
  assert.equal(original.revision,1);assert.equal(original.content.taskId,taskId);assert.ok(original.content.ranking);
  assert.doesNotMatch(JSON.stringify(original),/"ownerId"|"leaseOwner"|"fenceToken"|"inputSnapshot"|"storageKey"/);
  const events=await(await fetch(`${base}/api/v1/tasks/${taskId}/events`)).text();const ids=[...events.matchAll(/^id: (\d+)$/gm)].map(item=>Number(item[1]));
  assert.ok(ids.length>3);assert.deepEqual(ids,[...new Set(ids)].sort((a,b)=>a-b));
  const midpoint=ids[Math.floor(ids.length/2)]!;
  const resumed=await(await fetch(`${base}/api/v1/tasks/${taskId}/events`,{headers:{'last-event-id':String(midpoint)}})).text();
  assert.deepEqual([...resumed.matchAll(/^id: (\d+)$/gm)].map(item=>Number(item[1])),ids.filter(id=>id>midpoint));
  const exhausted=await fetch(`${base}/api/v1/tasks/${taskId}/events`,{headers:{'last-event-id':String(ids.at(-1))}});assert.equal(exhausted.status,204);
  const malformed=await fetch(`${base}/api/v1/tasks/${taskId}/events`,{headers:{'last-event-id':'bad'}});assert.equal(malformed.status,400);await malformed.body?.cancel();
  const input={weights:[{jobVersionId:original.content.ranking!.results[0]!.jobVersionId,weights:{...original.content.ranking!.results[0]!.weightsSnapshot,
   dimensionWeights:defaultScoringPolicy.dimensionWeights.map(item=>({...item,weight:item.dimension==='engineering'?2:1}))}}]},key=randomUUID();
  const before=budgetUsageSchema.parse((await database.client.analysisTask.findUniqueOrThrow({where:{id:taskId}})).budgetUsage);
  const send=(body:unknown,k=key)=>fetch(`${base}/api/v1/reports/${reportId}/recompute`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':k},body:JSON.stringify(body)});
  const [a,b]=await Promise.all([send(input),send(input)]);assert.equal(a.status,201);assert.equal(b.status,201);
  const revision=reportResponseSchema.parse(await a.json());assert.deepEqual(await b.json(),revision);assert.equal(revision.revision,2);assert.equal(revision.sourceReportId,reportId);
  assert.deepEqual(reportResponseSchema.parse(await(await fetch(`${base}/api/v1/reports/${reportId}`)).json()),original);
  assert.deepEqual(budgetUsageSchema.parse((await database.client.analysisTask.findUniqueOrThrow({where:{id:taskId}})).budgetUsage),before);
  const conflict=await send({weights:input.weights.map(item=>({...item,weights:{...item.weights,dimensionWeights:defaultScoringPolicy.dimensionWeights}}))});assert.equal(conflict.status,409);await conflict.body?.cancel();
  const invalid=await send({weights:input.weights.map(item=>({...item,weights:{...item.weights,dimensionWeights:[]}}))},randomUUID());assert.equal(invalid.status,400);assert.match(JSON.stringify(await invalid.json()),/details.*weights/);
  const revisions=reportListSchema.parse(await(await fetch(`${base}/api/v1/reports/${reportId}/revisions?limit=1`)).json());assert.equal(revisions.items[0]?.id,revision.id);assert.ok(revisions.nextCursor);
  const page=reportListSchema.parse(await(await fetch(`${base}/api/v1/reports/${reportId}/revisions?limit=1&cursor=${revisions.nextCursor}`)).json());assert.equal(page.items[0]?.id,reportId);
  assert.ok(analysisListSchema.parse(await(await fetch(`${base}/api/v1/analyses`)).json()).items.some(item=>item.id===taskId));
  assert.equal(analysisDetailSchema.parse(await(await fetch(`${base}/api/v1/analyses/${taskId}`)).json()).task.reportId,reportId);
  assert.ok(analysisOptionsSchema.parse(await(await fetch(`${base}/api/v1/analyses/options`)).json()).resumes.some(item=>item.resumeVersionId===original.content.input.resumeVersionId));
  ownerId=randomUUID();
  for(const path of [`reports/${reportId}`,`reports/${reportId}/revisions`,`tasks/${taskId}/events`,`analyses/${taskId}`]){const response=await fetch(`${base}/api/v1/${path}`);assert.equal(response.status,404);await response.body?.cancel();}
  const denied=await send(input,randomUUID());assert.equal(denied.status,404);await denied.body?.cancel();
  ownerId=owner;
  await app.close();app=await open();base=await app.getUrl();assert.deepEqual(await(await fetch(`${base}/api/v1/reports/${reportId}`)).json(),original);
  await assert.rejects(database.client.analysisReport.update({where:{id:reportId},data:{content:{}}}));
  // Open streams read new events persisted by an independent database client path, not an in-memory emitter.
  const queued=await new TaskRepository(database).createAnalysis(randomUUID(),{...analysisInput(),ownerId});
  const live=await fetch(`${base}/api/v1/tasks/${queued.taskId}/events`),reader=live.body!.getReader();await reader.read();
  await database.client.taskEvent.create({data:{id:randomUUID(),ownerId,taskType:'ANALYSIS',taskId:queued.taskId,analysisTaskId:queued.taskId,seq:1,stage:'TEST_PERSISTED',safeMessage:'Safe persisted event',counts:{schemaVersion:1,planned:2,completed:1,failed:0}}});
  const deadline=Date.now()+5000;let received='';while(!received.includes('id: 1')&&Date.now()<deadline){const chunk=await reader.read();if(chunk.done)break;received+=new TextDecoder().decode(chunk.value);}
  assert.match(received,/id: 1/);await reader.cancel();assert.equal((await database.client.analysisTask.findUniqueOrThrow({where:{id:queued.taskId}})).cancelRequested,false);
  const active:Response[]=[];try{for(let i=0;i<5;i++)active.push(await fetch(`${base}/api/v1/tasks/${queued.taskId}/events`,{headers:{'last-event-id':'1'}}));
   assert.ok(active.every(response=>response.status===200));const over=await fetch(`${base}/api/v1/tasks/${queued.taskId}/events`);assert.equal(over.status,429);await over.body?.cancel();
  }finally{for(const response of active)await response.body?.cancel();}
 }finally{await app.close();}
}
