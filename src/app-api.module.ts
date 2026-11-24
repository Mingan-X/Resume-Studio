import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './modules/config/config.module.js';
import type { ApiConfig } from './modules/config/app-config.js';
import { HealthModule } from './modules/health/health.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';
import { HttpErrorFilter } from './infrastructure/http/http-error.filter.js';

@Module({})
export class ApiModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [ConfigModule.register(config), LoggingModule, HealthModule],
      providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
    };
  }
}
