import {Module} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import {DatabaseService} from '../../infrastructure/database/database.service.js';
import {INFRA_CONFIG} from '../../infrastructure/tokens.js';
import {AuthRepository} from '../../infrastructure/tasks/auth.repository.js';
import {AUTH_CONFIG,authConfigSchema} from './auth-config.js';
import {AuthController} from './auth.controller.js';
import {APP_GUARD} from '@nestjs/core';
import {SessionGuard} from './session.guard.js';
@Module({})
export class AuthModule{
 static register(raw:unknown,protectBusiness=false):DynamicModule{const config=authConfigSchema.parse(raw);return {module:AuthModule,controllers:[AuthController],providers:[
  {provide:INFRA_CONFIG,useValue:{databaseUrl:config.databaseUrl}},{provide:AUTH_CONFIG,useValue:config},DatabaseService,AuthRepository,
  ...(protectBusiness?[{provide:APP_GUARD,useClass:SessionGuard}]:[])],exports:[AuthRepository]};}
}
