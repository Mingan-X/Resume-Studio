import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import type { TransactionDatabase } from '../database/transaction-port.js';
import { reportResponse, reportSummary } from './report-snapshot.js';
import { reportListSchema, pageQuerySchema } from '../../contracts/reports.js';
import { TaskNotFoundError } from '../../modules/tasks/task-errors.js';
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
}
