import {Body,Controller,Get,Headers,HttpCode,Inject,Param,Post,Query} from '@nestjs/common';
import type {z} from 'zod';
import {LifecycleRepository} from '../../infrastructure/tasks/lifecycle.repository.js';
import {IDENTITY} from '../identity/identity.module.js';
import type {IdentityPort} from '../identity/identity.module.js';
import {deletionPathSchema} from '../../contracts/lifecycle.js';
import {taskQuerySchema} from '../../contracts/task-api.js';
import {idempotencyKeySchema} from '../../contracts/tasks.js';
import {ZodValidationPipe,RequestValidationError} from '../../infrastructure/http/zod-validation.pipe.js';
@Controller('api/v1/data-deletions')
export class LifecycleController{
 constructor(private readonly lifecycle:LifecycleRepository,@Inject(IDENTITY)private readonly identity:IdentityPort){}
 @Post() @HttpCode(202)
 async create(@Headers('idempotency-key')key:unknown,@Headers('content-type')type:unknown,
  @Body(new ZodValidationPipe(taskQuerySchema))_body:unknown,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown){
  if(typeof type!=='string'||!/^application\/json(?:\s*;.*)?$/i.test(type))throw new RequestValidationError();
  const owner=await this.identity.getOwnerId(),id=await this.lifecycle.request(owner,idempotencyKeySchema.parse(key));return this.lifecycle.get(owner,id);
 }
 @Get(':requestId')async get(@Param(new ZodValidationPipe(deletionPathSchema))path:z.infer<typeof deletionPathSchema>,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown){
  return this.lifecycle.get(await this.identity.getOwnerId(),path.requestId);
 }
}
