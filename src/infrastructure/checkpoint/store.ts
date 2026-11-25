import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Pool } from 'pg';
import type { CheckpointConfig } from './config.js';

export function createCheckpointPool(databaseUrl: string, max: number): Pool {
  const pool = new Pool({
    connectionString: databaseUrl, max, connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 5_000, statement_timeout: 5_000,
    application_name: 'resume-studio-checkpoint',
  });
  // Idle socket failures must not crash the process or print connection details.
  // Active operations still reject; task recovery is established in S1.4.
  pool.on('error', () => {});
  return pool;
}

export function createCheckpointStore(config: CheckpointConfig) {
  const pool = createCheckpointPool(config.databaseUrl, config.poolMax);
  const saver = new PostgresSaver(pool, undefined, { schema: config.schema });
  // setup is deliberately absent from runtime creation and API/Worker startup.
  return { pool, saver, close: () => pool.end() };
}
