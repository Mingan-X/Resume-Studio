import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { INFRA_CONFIG } from '../../infrastructure/tokens.js';
import { ResumeRepository } from '../../infrastructure/storage/resume.repository.js';
import { LocalStorage } from '../../infrastructure/storage/local-storage.js';
import { IsolatedParser } from '../../infrastructure/parsing/isolation.js';
import { ResumeService, RESUME_PARSER, RESUME_STORAGE } from './resume.service.js';
import { ResumeController } from './resume.controller.js';
import {LifecycleRepository} from '../../infrastructure/tasks/lifecycle.repository.js';

@Module({})
export class ResumeApiModule {
  static register(config: { databaseUrl: string; storageRoot: string }, sessionIdentity=false): DynamicModule {
    return { module: ResumeApiModule, imports: [sessionIdentity?IdentityModule.session():IdentityModule], controllers: [ResumeController], providers: [
      { provide: INFRA_CONFIG, useValue: { databaseUrl: config.databaseUrl } }, DatabaseService, ResumeRepository, ResumeService,LifecycleRepository,
      { provide: RESUME_STORAGE, useFactory: () => LocalStorage.create(config.storageRoot) },
      { provide: RESUME_PARSER, useFactory: () => new IsolatedParser() },
    ] };
  }
}
