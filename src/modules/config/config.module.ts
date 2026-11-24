import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { AppConfig } from './app-config.js';

const APP_CONFIG = Symbol('APP_CONFIG');

@Injectable()
export class ConfigService {
  constructor(@Inject(APP_CONFIG) readonly values: AppConfig) {}
}

@Global()
@Module({})
export class ConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }, ConfigService],
      exports: [ConfigService],
    };
  }
}
