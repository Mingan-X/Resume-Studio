import { Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from './modules/config/config.module.js';
import type { WorkerConfig } from './modules/config/app-config.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';

@Injectable()
class WorkerLifetime implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  onModuleInit(): void {
    // Infrastructure diagnostics run in a separate context. Keep this idle until a task consumer is available.
    this.timer = setInterval(() => {}, 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }
}

@Module({})
export class WorkerModule {
  static register(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [ConfigModule.register(config), LoggingModule],
      providers: [WorkerLifetime],
    };
  }
}
