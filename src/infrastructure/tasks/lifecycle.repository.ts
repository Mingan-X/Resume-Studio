import {Injectable,ConflictException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DatabaseService} from '../database/database.service.js';
import {deletionResponseSchema,deletionResourceSchema} from '../../contracts/lifecycle.js';
import type {DeletionResource} from '../../contracts/lifecycle.js';
import type {Prisma} from '../../generated/prisma/client.js';
import {executionLockKey} from '../consumer/task-execution.lock.js';
const terminal=['SUCCEEDED','PARTIAL','FAILED','CANCELLED'];
export async function ownerLifecycleLock(tx:Prisma.TransactionClient,owner:string){
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner}::text,7325))::text`;
}
@Injectable()
export class LifecycleRepository{
 constructor(private readonly database:DatabaseService){}
 async begin(owner:string,kind:'UPLOAD'|'SUGGEST'|'VECTOR'){
  return this.database.client.resourceOperation.create({data:{id:randomUUID(),ownerId:z.uuid().parse(owner),kind}});
 }
 async stopped(id:string){await this.database.client.resourceOperation.update({where:{id:z.uuid().parse(id)},data:{stoppedAt:new Date()}});}
 async trace(owner:string,traceId:string,taskId?:string){await this.database.client.resourceTrace.create({data:{ownerId:z.uuid().parse(owner),
  traceId:z.string().regex(/^[a-f0-9]{32}$/).parse(traceId),...(taskId?{taskId:z.uuid().parse(taskId)}:{})}});}
 async request(owner:string,key:string,resumeVersionId?:string){
  const ownerId=z.uuid().parse(owner);z.string().min(1).max(80).parse(key);
  return this.database.client.$transaction(async tx=>{
   await ownerLifecycleLock(tx,ownerId);
   if(!await tx.account.findUnique({where:{ownerId}}))throw new NotFoundException();
   const prior=await tx.deletionRequest.findUnique({where:{ownerId_idempotencyKey:{ownerId,idempotencyKey:key}}});
   if(prior){if(prior.scope!==(resumeVersionId?'RESUME':'ALL')||prior.resumeVersionId!==(resumeVersionId??null))throw new ConflictException();return prior.id;}
   const active=await tx.deletionRequest.findFirst({where:{ownerId,status:{not:'DONE'},scope:'ALL'}});if(active)return active.id;
   if(resumeVersionId){
    const resume=await tx.resumeVersion.findFirst({where:{ownerId,id:z.uuid().parse(resumeVersionId)}});if(!resume)throw new NotFoundException();
    const duplicate=await tx.deletionRequest.findFirst({where:{ownerId,resumeVersionId,status:{not:'DONE'}}});if(duplicate)return duplicate.id;
    if(resume.createdAt.getTime()+30*86400000>Date.now())throw new ConflictException();
   }
   const row=await tx.deletionRequest.create({data:{id:randomUUID(),ownerId,idempotencyKey:key,scope:resumeVersionId?'RESUME':'ALL',resumeVersionId:resumeVersionId??null}});
   return row.id;
  });
 }
 async get(owner:string,id:string){const row=await this.database.client.deletionRequest.findFirst({where:{ownerId:z.uuid().parse(owner),id:z.uuid().parse(id)},include:{steps:{select:{completedAt:true}}}});
  if(!row)throw new NotFoundException();return deletionResponseSchema.parse({id:row.id,scope:row.scope,resumeVersionId:row.resumeVersionId,status:row.status,reason:row.reason,
   createdAt:row.createdAt.toISOString(),completedAt:row.completedAt?.toISOString()??null,completedSteps:row.status==='DONE'?row.stepCount:row.steps.filter(step=>step.completedAt).length,totalSteps:row.stepCount});}
 async due(limit=20,signal?:AbortSignal){
  signal?.throwIfAborted();
  const size=z.int().min(1).max(100).parse(limit);
  const rows=z.array(z.object({id:z.uuid(),ownerId:z.uuid()})).parse(await this.database.client.$queryRaw`
   SELECT r.id,r.owner_id AS "ownerId" FROM resume_version r JOIN account a ON a.owner_id=r.owner_id
   WHERE r.created_at<=clock_timestamp()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM deletion_request d
    WHERE d.owner_id=r.owner_id AND d.status<>'DONE' AND (d.scope='ALL' OR d.resume_version_id=r.id)) ORDER BY r.created_at,r.id LIMIT ${size}`);
  const ids:string[]=[];for(const row of rows){signal?.throwIfAborted();ids.push(await this.request(row.ownerId,`expiry:${row.id}`,row.id));}return ids;
 }
 async prepare(id:string){return this.database.client.$transaction(async tx=>{
  const request=await tx.deletionRequest.findUniqueOrThrow({where:{id},include:{steps:true}});await ownerLifecycleLock(tx,request.ownerId);
  if(request.status==='DONE')return 'done';if(request.status==='RUNNING')return 'ready';
  const where={ownerId:request.ownerId},all=request.scope==='ALL';
  const analyses=await tx.analysisTask.findMany({where:{...where,...(!all?{realResumeVersionId:request.resumeVersionId}:{})}});
  const indexes=all?await tx.jobIndexTask.findMany({where}):[];
  let active=await tx.resourceOperation.count({where:{...where,stoppedAt:null}})>0;
  for(const task of [...analyses,...indexes]){
   const type='activeGraphThreadId'in task?'analysis':'job-index';
   const lock=z.array(z.object({acquired:z.boolean()})).parse(await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${executionLockKey(request.ownerId,type,task.id)}::bigint) AS acquired`)[0];
   if(!lock?.acquired||!terminal.includes(task.status))active=true;
   if(await tx.taskAttempt.count({where:{...where,taskId:task.id,executionStoppedAt:null}})>0)active=true;
  }
  if(active){await tx.deletionRequest.update({where:{id},data:{reason:'ACTIVE_EXECUTION'}});return 'waiting';}
  const account=await tx.account.findUniqueOrThrow({where:{ownerId:request.ownerId}});
  if(!account.lifecycleHistoryComplete||analyses.some(task=>!task.lifecycleHistoryComplete)){await tx.deletionRequest.update({where:{id},data:{reason:'INCOMPLETE_HISTORY'}});return 'waiting';}
  const versions=await tx.resumeVersion.findMany({where:{...where,...(!all?{id:request.resumeVersionId!}:{})},include:{fileAsset:true}});
  const files=all?await tx.fileAsset.findMany({where}):await tx.fileAsset.findMany({where:{...where,id:{in:versions.map(row=>row.fileAssetId)},
   versions:{none:{id:{notIn:versions.map(row=>row.id)}}}}});
  const resources:DeletionResource[]=files.map(file=>deletionResourceSchema.parse({kind:'FILE',storageKey:file.storageKey,sha256:file.sha256,size:file.size}));
  const tasks=analyses.map(task=>task.id);
  const threads=await tx.taskCheckpointThread.findMany({where:{...where,taskId:{in:tasks}}});
  resources.push(...threads.map(row=>({kind:'CHECKPOINT' as const,threadId:row.threadId})));
  const traces=await tx.resourceTrace.findMany({where:{...where,...(!all?{taskId:{in:tasks}}:{})}});
  resources.push(...traces.map(row=>({kind:'TRACE' as const,traceId:row.traceId})));
  if(all)resources.push({kind:'VECTOR',ownerId:request.ownerId});
  for(const resource of resources){const checked=deletionResourceSchema.parse(resource),resourceKey=JSON.stringify(checked.kind==='FILE'?['FILE',checked.storageKey]:checked.kind==='CHECKPOINT'?['CHECKPOINT',checked.threadId]:checked.kind==='TRACE'?['TRACE',checked.traceId]:['VECTOR',checked.ownerId]);
   await tx.deletionStep.createMany({skipDuplicates:true,data:{id:randomUUID(),requestId:id,resourceKey,resource:checked}});
  }
  await tx.deletionRequest.update({where:{id},data:{status:'RUNNING',reason:null,stepCount:await tx.deletionStep.count({where:{requestId:id}})}});return 'ready';
 });}
 async eraseBusiness(id:string){return this.database.client.$transaction(async tx=>{
  const request=await tx.deletionRequest.findUniqueOrThrow({where:{id}});await ownerLifecycleLock(tx,request.ownerId);
  if(request.status==='DONE')return;if(request.status!=='RUNNING'||await tx.deletionStep.count({where:{requestId:id,completedAt:null}}))throw new Error('DELETE_STEPS_PENDING');
  const where={ownerId:request.ownerId},all=request.scope==='ALL';
  const versions=await tx.resumeVersion.findMany({where:{...where,...(!all?{id:request.resumeVersionId!}:{})}}),versionIds=versions.map(v=>v.id);
  const tasks=await tx.analysisTask.findMany({where:{...where,...(!all?{realResumeVersionId:{in:versionIds}}:{})},select:{id:true}}),taskIds=tasks.map(t=>t.id);
  const scoped={...where,taskId:{in:taskIds}};
  await tx.reportRecomputeRequest.deleteMany({where:{...where,report:{taskId:{in:taskIds}}}});
  await tx.analysisReport.deleteMany({where:scoped});await tx.rankingSnapshot.deleteMany({where:{...where,scoreSet:{taskId:{in:taskIds}}}});await tx.scoreSet.deleteMany({where:scoped});
  await tx.analysisSummary.deleteMany({where:scoped});await tx.matchPlan.deleteMany({where:scoped});await tx.profileAssessment.deleteMany({where:scoped});
  await tx.candidateSet.deleteMany({where:scoped});
  for(const type of ['ANALYSIS',...(all?['JOB_INDEX']:[])] as const){
   const filter={...where,...(type==='ANALYSIS'?{taskId:{in:taskIds}}:{})};
   await tx.nodeArtifact.deleteMany({where:filter});await tx.consumerReceipt.deleteMany({where:filter});await tx.taskEvent.deleteMany({where:filter});await tx.taskAttempt.deleteMany({where:filter});
  }
  await tx.outboxEvent.deleteMany({where:{...where,...(!all?{aggregateType:'AnalysisTask',aggregateId:{in:taskIds}}:{})}});
  await tx.resourceTrace.deleteMany({where:{...where,...(!all?{taskId:{in:taskIds}}:{})}});
  await tx.analysisTask.deleteMany({where:{...where,id:{in:taskIds}}});
  await tx.resumeExtraction.deleteMany({where:{...where,resumeVersionId:{in:versionIds}}});await tx.resumeUpload.deleteMany({where:{...where,resumeVersionId:{in:versionIds}}});
  await tx.extractedDocument.deleteMany({where:{...where,sourceVersionId:{in:versionIds}}});await tx.evidenceBlock.deleteMany({where:{...where,sourceVersionId:{in:versionIds}}});
  await tx.resumeVersion.deleteMany({where:{...where,id:{in:versionIds}}});await tx.resume.deleteMany({where:{...where,versions:{none:{}}}});
  await tx.fileAsset.deleteMany({where:{...where,...(!all?{id:{in:versions.map(v=>v.fileAssetId)}}:{}),versions:{none:{}}}});
  if(all){
   await tx.jobIndexTarget.deleteMany({where});await tx.jobIndexRequest.deleteMany({where});await tx.jobIndexTask.deleteMany({where});
   await tx.jobCorpusVersion.deleteMany({where});await tx.jobVersion.deleteMany({where});await tx.job.deleteMany({where});
   await tx.analysisConfiguration.deleteMany({where});await tx.scoringPolicy.deleteMany({where});await tx.rubricVersion.deleteMany({where});
   await tx.syntheticIndexTarget.deleteMany({where});await tx.quarantine.deleteMany({where});await tx.resourceOperation.deleteMany({where});
   const older=await tx.deletionRequest.findMany({where:{...where,id:{not:id},status:{not:'DONE'}},select:{id:true}});
   await tx.deletionStep.deleteMany({where:{requestId:{in:older.map(item=>item.id)}}});
   await tx.deletionRequest.updateMany({where:{...where,id:{in:older.map(item=>item.id)}},data:{status:'DONE',reason:null,completedAt:new Date()}});
  }
  await tx.deletionStep.deleteMany({where:{requestId:id}}); // No file keys or trace/thread identifiers survive completion.
  await tx.deletionRequest.update({where:{id},data:{status:'DONE',reason:null,completedAt:new Date()}});
 });}
}
