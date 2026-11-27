import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import type { TransactionDatabase } from '../database/transaction-port.js';
import { ScoringRepository } from './scoring.repository.js';
import { reportResponse, reportSummary } from './report-snapshot.js';
import { reportContentSchema, reportListSchema, recomputeRequestSchema, pageQuerySchema } from '../../contracts/reports.js';
import { realAnalysisInputSchema, idempotencyKeySchema } from '../../contracts/tasks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { TaskNotFoundError, AnalysisInputStateError, IdempotencyConflictError } from '../../modules/tasks/task-errors.js';
import { RequestValidationError } from '../http/zod-validation.pipe.js';

const cursorSchema=z.object({createdAt:z.iso.datetime(),id:z.uuid()}).strict();
export function decodePage(raw:unknown){const query=pageQuerySchema.parse(raw);let cursor:z.infer<typeof cursorSchema>|undefined;
 if(query.cursor)try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')) as unknown);}catch{throw new RequestValidationError();}
 return {limit:query.limit,cursor};}
export function nextPage(rows:{id:string;createdAt:Date}[],limit:number){const last=rows.slice(0,limit).at(-1);return rows.length>limit&&last?Buffer.from(JSON.stringify({id:last.id,createdAt:last.createdAt.toISOString()})).toString('base64url'):null;}
@Injectable()
export class ReportRepository {
 constructor(@Inject(DatabaseService)private readonly database:TransactionDatabase){}
 async get(owner:string,id:string){const ownerId=z.uuid().parse(owner),reportId=z.uuid().parse(id);return this.database.client.$transaction(async tx=>{
  const row=await tx.analysisReport.findFirst({where:{ownerId,id:reportId}});if(!row)throw new TaskNotFoundError();return reportResponse(row);
 });}
 async list(owner:string,raw:unknown,sourceId?:string){const ownerId=z.uuid().parse(owner),{limit,cursor}=decodePage(raw);return this.database.client.$transaction(async tx=>{
  const source=sourceId?await tx.analysisReport.findFirst({where:{ownerId,id:z.uuid().parse(sourceId)}}):null;
  if(sourceId&&!source)throw new TaskNotFoundError();
  const rows=await tx.analysisReport.findMany({where:{ownerId,...(source?{taskId:source.taskId}:{}),...(cursor?{OR:[{createdAt:{lt:new Date(cursor.createdAt)}},{createdAt:new Date(cursor.createdAt),id:{lt:cursor.id}}]}:{})},orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit+1});
  return reportListSchema.parse({items:rows.slice(0,limit).map(reportSummary),nextCursor:nextPage(rows,limit)});
 });}
 async recompute(owner:string,id:string,key:unknown,raw:unknown){const ownerId=z.uuid().parse(owner),sourceId=z.uuid().parse(id),idempotencyKey=idempotencyKeySchema.parse(key),request=recomputeRequestSchema.parse(raw);
  const hash=requestHash({sourceId,request});return this.database.client.$transaction(async tx=>{
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ownerId,idempotencyKey])},31))::text`;
   const prior=await tx.reportRecomputeRequest.findUnique({where:{ownerId_idempotencyKey:{ownerId,idempotencyKey}},include:{report:true}});
   if(prior){if(prior.requestHash!==hash)throw new IdempotencyConflictError();return reportResponse(prior.report);}
   const source=await tx.analysisReport.findFirst({where:{ownerId,id:sourceId}});if(!source)throw new TaskNotFoundError();
   const original=reportResponse(source).content;if(!original.scoreSetId)throw new AnalysisInputStateError();
   await tx.$queryRaw`SELECT id FROM analysis_task WHERE owner_id=${ownerId}::uuid AND id=${source.taskId}::uuid FOR UPDATE`;
   let recalculated;
   try{recalculated=await new ScoringRepository(this.database).recomputeWithin(tx,ownerId,original.scoreSetId,request.weights);}catch(error){
    if(error instanceof Error&&['SCORING_OVERRIDE_INVALID','DIMENSION_REQUIREMENT_WEIGHT_ZERO','PARTICIPATING_DIMENSION_WEIGHT_ZERO'].includes(error.message))throw new RequestValidationError([{path:'weights',code:'custom'}]);throw error;
   }
   const content=reportContentSchema.parse({...original,scoreSetId:recalculated.score.id,ranking:recalculated.ranking.content});
   const last=await tx.analysisReport.findFirstOrThrow({where:{ownerId,taskId:source.taskId},orderBy:{revision:'desc'}}),reportId=randomUUID();
   const row=await tx.analysisReport.create({data:{id:reportId,ownerId,taskId:source.taskId,revision:last.revision+1,rootReportId:source.rootReportId,sourceReportId:source.id,
    operationKey:requestHash({ownerId,idempotencyKey,hash}),inputSnapshot:realAnalysisInputSchema.parse(source.inputSnapshot),content,contentHash:requestHash(content)}});
   await tx.reportRecomputeRequest.create({data:{ownerId,idempotencyKey,requestHash:hash,reportId}});return reportResponse(row);
  });
 }
}
