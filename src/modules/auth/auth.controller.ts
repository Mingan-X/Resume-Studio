import {Body,Controller,Get,Headers,HttpCode,Inject,Post,Query,Res,UnauthorizedException} from '@nestjs/common';
import type {ServerResponse} from 'node:http';
import type {z} from 'zod';
import {AuthRepository} from '../../infrastructure/tasks/auth.repository.js';
import {AUTH_CONFIG} from './auth-config.js';
import type {AuthConfig} from './auth-config.js';
import {csrfFor,readSessionCookie,requireCsrf,sessionCookie,createSessionToken} from './session-token.js';
import {loginRequestSchema,authSessionResponseSchema,authMeResponseSchema,logoutResponseSchema} from '../../contracts/auth.js';
import {taskQuerySchema} from '../../contracts/task-api.js';
import {ZodValidationPipe,RequestValidationError} from '../../infrastructure/http/zod-validation.pipe.js';
@Controller('api/v1/auth')
export class AuthController{
 constructor(private readonly sessions:AuthRepository,@Inject(AUTH_CONFIG)private readonly config:AuthConfig){}
 private async resolve(cookie:unknown){const token=readSessionCookie(typeof cookie==='string'?cookie:undefined);return token?this.sessions.session(token):null;}
 private response(value:{token:string;expiresAt:Date;account?:{id:string;username:string}|null}){return authSessionResponseSchema.parse({user:value.account?{id:value.account.id,username:value.account.username}:null,csrfToken:csrfFor(value.token),expiresAt:value.expiresAt.toISOString()});}
 @Get('session')
 async session(@Headers('cookie')cookie:unknown,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown,@Res({passthrough:true})response:ServerResponse){
  response.setHeader('cache-control','no-store');const existing=await this.resolve(cookie);if(existing)return this.response(existing);
  const created=await this.sessions.createAnonymous(this.config.anonymousSeconds);response.setHeader('set-cookie',sessionCookie(created.token,this.config.anonymousSeconds));return this.response(created);
 }
 @Get('me')
 async me(@Headers('cookie')cookie:unknown,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown,@Res({passthrough:true})response:ServerResponse){
  response.setHeader('cache-control','no-store');const current=await this.resolve(cookie);if(!current?.account)throw new UnauthorizedException();return authMeResponseSchema.parse(this.response(current));
 }
 @Post('login') @HttpCode(200)
 async login(@Body(new ZodValidationPipe(loginRequestSchema))body:z.infer<typeof loginRequestSchema>,@Headers('cookie')cookie:unknown,@Headers('x-csrf-token')csrf:unknown,
  @Headers('origin')origin:unknown,@Headers('content-type')type:unknown,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown,@Res({passthrough:true})response:ServerResponse){
  if(typeof type!=='string'||!/^application\/json(?:\s*;.*)?$/i.test(type))throw new RequestValidationError();
  const current=await this.resolve(cookie);if(!current)throw new UnauthorizedException();requireCsrf(current.token,csrf,origin,this.config.origin);
  const logged=await this.sessions.login(current.token,body.username,body.password,this.config.sessionSeconds);
  response.setHeader('set-cookie',sessionCookie(logged.token,this.config.sessionSeconds));response.setHeader('cache-control','no-store');return authMeResponseSchema.parse(this.response(logged));
 }
 @Post('logout') @HttpCode(200)
 async logout(@Headers('cookie')cookie:unknown,@Headers('x-csrf-token')csrf:unknown,@Headers('origin')origin:unknown,
 @Body(new ZodValidationPipe(taskQuerySchema))_body:unknown,@Query(new ZodValidationPipe(taskQuerySchema))_query:unknown,@Res({passthrough:true})response:ServerResponse){
  const current=await this.resolve(cookie);if(!current)throw new UnauthorizedException();requireCsrf(current.token,csrf,origin,this.config.origin);await this.sessions.logout(current.token);
  response.setHeader('set-cookie',sessionCookie(createSessionToken(),0));response.setHeader('cache-control','no-store');return logoutResponseSchema.parse({loggedOut:true});
 }
}
