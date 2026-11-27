import {Module} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import {DatabaseService} from '../../infrastructure/database/database.service.js';
import {INFRA_CONFIG} from '../../infrastructure/tokens.js';
import {AuthRepository} from '../../infrastructure/tasks/auth.repository.js';
import {AUTH_CONFIG,authConfigSchema} from './auth-config.js';
import {AuthController} from './auth.controller.js';
import {APP_GUARD} from '@nestjs/core';
import {SessionGuard} from './session.guard.js';
import {LifecycleRepository} from '../../infrastructure/tasks/lifecycle.repository.js';
import {LifecycleController} from './lifecycle.controller.js';
import {IdentityModule} from '../identity/identity.module.js';
@Module({})
export class AuthModule{
 static register(raw:unknown,protectBusiness=false):DynamicModule{const config=authConfigSchema.parse(raw);return {module:AuthModule,imports:[IdentityModule.session()],controllers:[AuthController,...(protectBusiness?[LifecycleController]:[])],providers:[
  {provide:INFRA_CONFIG,useValue:{databaseUrl:config.databaseUrl}},{provide:AUTH_CONFIG,useValue:config},DatabaseService,AuthRepository,LifecycleRepository,
  ...(protectBusiness?[{provide:APP_GUARD,useClass:SessionGuard}]:[])],exports:[AuthRepository]};}
}
