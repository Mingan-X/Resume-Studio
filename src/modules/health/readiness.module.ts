import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Pool } from 'pg';
import { withRabbitConnection } from '../../infrastructure/messaging/confirmed-publisher.js';
import { taskTopology } from '../../infrastructure/messaging/task-topology.js';
import { readinessConfigSchema } from './readiness-config.js';
import type { ReadinessConfig } from './readiness-config.js';
import { ReadinessService } from './readiness.service.js';
import { ReadinessController } from './readiness.controller.js';

export function readinessDependencies(config: ReadinessConfig) {
    const pool = new Pool({ connectionString: config.databaseUrl,
      max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000, idleTimeoutMillis: 5000,
      application_name: 'resume-studio-readiness' });
    pool.on('error', () => {});
    const service = new ReadinessService(async () => { await pool.query('SELECT 1'); }, async () => {
        await withRabbitConnection(config.rabbitmqUrl, 2000, async connection => {
          const channel = await connection.createChannel(); channel.on('error', () => {});
          const topology = taskTopology(); await channel.checkQueue(topology.analysis); await channel.checkQueue(topology.jobIndex);
        });
      });
    return { service, close: () => pool.end() };
}
@Module({})
export class ReadinessModule {
  static register(raw: unknown): DynamicModule {
    const dependencies = readinessDependencies(readinessConfigSchema.parse(raw));
    return { module: ReadinessModule, controllers: [ReadinessController], providers: [
      { provide: 'READINESS_POOL_LIFECYCLE', useValue: { onModuleDestroy: dependencies.close } },
      { provide: ReadinessService, useValue: dependencies.service },
    ] };
  }
}
