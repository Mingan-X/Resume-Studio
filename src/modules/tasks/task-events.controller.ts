import {Controller,Get,Headers,Inject,Injectable,HttpException,Param,Query,Res} from '@nestjs/common';
import type {ServerResponse} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import type {z} from 'zod';
import {IDENTITY,ownerIdSchema} from '../identity/identity.module.js';
import type {IdentityPort} from '../identity/identity.module.js';
import {TaskEventRepository} from '../../infrastructure/tasks/task-event.repository.js';
import {taskPathSchema,taskQuerySchema} from '../../contracts/task-api.js';
import {lastEventIdSchema} from '../../contracts/analysis-api.js';
import {RequestValidationError,ZodValidationPipe} from '../../infrastructure/http/zod-validation.pipe.js';

@Injectable()
export class EventStreamLimits {
 private readonly owners=new Map<string,number>();private total=0;
 acquire(owner:string){const count=this.owners.get(owner)??0;if(count>=5||this.total>=100)throw new HttpException('Stream limit',429);this.owners.set(owner,count+1);this.total++;
  let released=false;return ()=>{if(released)return;released=true;this.total--;const next=(this.owners.get(owner)??1)-1;if(next)this.owners.set(owner,next);else this.owners.delete(owner);};}
}
@Controller('api/v1/tasks')
export class TaskEventsController {
 constructor(@Inject(IDENTITY)private readonly identity:IdentityPort,private readonly events:TaskEventRepository,private readonly limits:EventStreamLimits){}
 @Get(':taskId/events')
 async stream(@Param(new ZodValidationPipe(taskPathSchema))path:z.infer<typeof taskPathSchema>,@Headers('last-event-id')raw:unknown,
 @Query(new ZodValidationPipe(taskQuerySchema))_query:unknown,@Res()response:ServerResponse){
  const parsed=lastEventIdSchema.safeParse(raw??'0');if(!parsed.success)throw new RequestValidationError();let cursor=parsed.data;
  const owner=ownerIdSchema.parse(await this.identity.getOwnerId()),release=this.limits.acquire(owner),abort=new AbortController(),stop=()=>abort.abort();
  response.once('close',stop);const timer=setTimeout(stop,300000);let opened=false;
  try{
   let page=await this.events.read(owner,path.taskId,cursor);
   if(page.terminal&&!page.events.length){response.writeHead(204);response.end();return;}
   response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});response.flushHeaders();opened=true;
   const write=async(value:string)=>{if(!response.write(value))await once(response,'drain',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});};
   await write('retry: 2000\n\n');let heartbeat=Date.now();
   while(!abort.signal.aborted){
    for(const event of page.events){await write(`id: ${event.seq}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`);cursor=event.seq;}
    if(page.terminal&&cursor>=page.lastSeq){response.end();break;}
    if(Date.now()-heartbeat>=15000){await write(': heartbeat\n\n');heartbeat=Date.now();}
    if(page.events.length<100)await delay(1000,undefined,{signal:abort.signal});
    page=await this.events.read(owner,path.taskId,cursor);
   }
  }catch(error){if(!opened&&!abort.signal.aborted)throw error;if(!response.destroyed)response.end();}
  finally{clearTimeout(timer);response.off('close',stop);abort.abort();release();if(opened&&!response.writableEnded&&!response.destroyed)response.end();}
 }
}
