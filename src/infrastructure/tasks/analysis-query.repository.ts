import {Injectable} from '@nestjs/common';
import {z} from 'zod';
import {DatabaseService} from '../database/database.service.js';
import {realAnalysisInputSchema} from '../../contracts/tasks.js';
import {reportInputSchema} from '../../contracts/reports.js';
import {analysisListItemSchema,analysisListSchema,analysisOptionsSchema,analysisOptionsQuerySchema} from '../../contracts/analysis-api.js';
import {corpusManifestSchema} from '../../contracts/job-corpus.js';
import {decodePage,nextPage} from './report.repository.js';
import {TaskNotFoundError} from '../../modules/tasks/task-errors.js';
import {requestHash} from '../../modules/tasks/request-hash.js';
import {RequestValidationError} from '../http/zod-validation.pipe.js';
import {versionNameSchema} from '../../contracts/jobs.js';
const corpusCursorSchema=z.object({createdAt:z.iso.datetime(),version:versionNameSchema}).strict();
function project(row:{id:string;createdAt:Date;inputSnapshot:unknown;status:string;stage:string;reportId:string|null}){
 const input=realAnalysisInputSchema.parse(row.inputSnapshot);
 return analysisListItemSchema.parse({id:row.id,createdAt:row.createdAt.toISOString(),input:reportInputSchema.strip().parse(input),status:row.status,stage:row.stage,reportId:row.reportId});
}
@Injectable()
export class AnalysisQueryRepository{
 constructor(private readonly database:DatabaseService){}
 async list(owner:string,raw:unknown){const ownerId=z.uuid().parse(owner),{limit,cursor}=decodePage(raw);
  const rows=await this.database.client.analysisTask.findMany({where:{ownerId,inputSnapshot:{path:['kind'],equals:'analysis'},...(cursor?{OR:[{createdAt:{lt:new Date(cursor.createdAt)}},{createdAt:new Date(cursor.createdAt),id:{lt:cursor.id}}]}:{})},orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit+1});
  return analysisListSchema.parse({items:rows.slice(0,limit).map(project),nextCursor:nextPage(rows,limit)});
 }
 async get(owner:string,id:string){const ownerId=z.uuid().parse(owner),taskId=z.uuid().parse(id),row=await this.database.client.analysisTask.findFirst({where:{ownerId,id:taskId,inputSnapshot:{path:['kind'],equals:'analysis'}}});
  if(!row)throw new TaskNotFoundError();return project(row);
 }
 async options(owner:string,raw:unknown){const ownerId=z.uuid().parse(owner),query=analysisOptionsQuerySchema.parse(raw);
  const resume=decodePage({limit:query.limit,...(query.resumeCursor?{cursor:query.resumeCursor}:{})});let corpus:z.infer<typeof corpusCursorSchema>|undefined;
  if(query.corpusCursor)try{corpus=corpusCursorSchema.parse(JSON.parse(Buffer.from(query.corpusCursor,'base64url').toString('utf8')) as unknown);}catch{throw new RequestValidationError();}
  const resumes=await this.database.client.resumeVersion.findMany({where:{ownerId,extractedDocument:{isNot:null},...(resume.cursor?{OR:[{createdAt:{lt:new Date(resume.cursor.createdAt)}},{createdAt:new Date(resume.cursor.createdAt),id:{lt:resume.cursor.id}}]}:{})},orderBy:[{createdAt:'desc'},{id:'desc'}],take:query.limit+1});
  const rows=await this.database.client.jobCorpusVersion.findMany({where:{ownerId,...(corpus?{OR:[{createdAt:{lt:new Date(corpus.createdAt)}},{createdAt:new Date(corpus.createdAt),version:{lt:corpus.version}}]}:{})},orderBy:[{createdAt:'desc'},{version:'desc'}],take:query.limit+1});
  const corpora=rows.slice(0,query.limit).map(row=>{const content=corpusManifestSchema.parse(row.manifest);if(requestHash(content)!==row.contentHash)throw new Error('CORPUS_HASH_INVALID');return {version:row.version,createdAt:row.createdAt.toISOString(),contentHash:row.contentHash,jobCount:content.members.length};});
  const last=rows.slice(0,query.limit).at(-1);
  return analysisOptionsSchema.parse({resumes:resumes.slice(0,query.limit).map(row=>({resumeId:row.resumeId,resumeVersionId:row.id,version:row.version,createdAt:row.createdAt.toISOString(),fileHash:row.fileHash})),
   corpora,configuration:null,nextResumeCursor:nextPage(resumes,query.limit),nextCorpusCursor:rows.length>query.limit&&last?Buffer.from(JSON.stringify({createdAt:last.createdAt.toISOString(),version:last.version})).toString('base64url'):null});
 }
}
