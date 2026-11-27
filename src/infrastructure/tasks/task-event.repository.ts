import {Injectable} from '@nestjs/common';
import {z} from 'zod';
import {DatabaseService} from '../database/database.service.js';
import {taskEventResponseSchema} from '../../contracts/analysis-api.js';
import {TaskNotFoundError} from '../../modules/tasks/task-errors.js';
import {RequestValidationError} from '../http/zod-validation.pipe.js';
@Injectable()
export class TaskEventRepository {
 constructor(private readonly database:DatabaseService){}
 async read(owner:string,id:string,after:number){const ownerId=z.uuid().parse(owner),taskId=z.uuid().parse(id);z.int().nonnegative().max(2147483647).parse(after);
  return this.database.client.$transaction(async tx=>{
   const analysis=await tx.analysisTask.findFirst({where:{ownerId,id:taskId}}),index=await tx.jobIndexTask.findFirst({where:{ownerId,id:taskId}});
   if(analysis&&index)throw new Error('AMBIGUOUS_TASK_ID');const task=analysis??index;if(!task)throw new TaskNotFoundError();
   const taskType=analysis?'ANALYSIS':'JOB_INDEX';const last=await tx.taskEvent.findFirst({where:{ownerId,taskType,taskId},orderBy:{seq:'desc'}});
   if(after>(last?.seq??0))throw new RequestValidationError();
   const rows=await tx.taskEvent.findMany({where:{ownerId,taskType,taskId,seq:{gt:after}},orderBy:{seq:'asc'},take:100});
   return {events:rows.map(row=>taskEventResponseSchema.parse({taskId,seq:row.seq,stage:row.stage,counts:row.counts,message:row.safeMessage,createdAt:row.createdAt.toISOString()})),
    terminal:['SUCCEEDED','PARTIAL','FAILED','CANCELLED'].includes(task.status),lastSeq:last?.seq??0};
  });
 }
}
