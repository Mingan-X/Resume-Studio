import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { INFRA_CONFIG } from '../tokens.js';
import type { InfrastructureConfig } from '../config.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly client: PrismaClient;
  private healthy = true;

  constructor(@Inject(INFRA_CONFIG) config: Pick<InfrastructureConfig, 'databaseUrl'>) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      application_name: 'resume-studio-s12',
    });
    this.pool.on('error', () => { this.healthy = false; });
    this.client = new PrismaClient({
      adapter: new PrismaPg(this.pool),
      transactionOptions: { maxWait: 3_000, timeout: 5_000 },
      log: [],
    });
  }

  async check(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
    this.healthy = true;
  }

  get connectionHealthy(): boolean { return this.healthy; }

  async onModuleDestroy(): Promise<void> {
    try { await this.client.$disconnect(); }
    finally { await this.pool.end(); }
  }
}
