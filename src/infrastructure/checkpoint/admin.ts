import { execFile } from 'node:child_process';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { PoolClient } from 'pg';
import type { CheckpointConfig } from './config.js';
import { createCheckpointPool } from './store.js';
import { ownedPostgres } from './ownership.js';

export async function provisionCheckpoint(config: CheckpointConfig, setupUrl: string): Promise<void> {
  const id = await ownedPostgres();
  // Both URLs have already passed role/database/hex-password validation.
  const runtimePassword = new URL(config.databaseUrl).password;
  const setupPassword = new URL(setupUrl).password;
  const sql = String.raw`
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('resume_studio_checkpoint', 'resume_studio_checkpoint_setup')
      AND shobj_description(oid, 'pg_authid') IS DISTINCT FROM 'resume-studio:s1.3:checkpoint')
      OR EXISTS (SELECT 1 FROM pg_database WHERE datname = 'resume_studio_checkpoint'
      AND shobj_description(oid, 'pg_database') IS DISTINCT FROM 'resume-studio:s1.3:checkpoint') THEN
    RAISE EXCEPTION 'Refusing preexisting resources without checkpoint ownership markers';
  END IF;
END $$;
SELECT 'CREATE ROLE resume_studio_checkpoint LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ''${runtimePassword}'''
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resume_studio_checkpoint')\gexec
SELECT 'CREATE ROLE resume_studio_checkpoint_setup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ''${setupPassword}'''
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resume_studio_checkpoint_setup')\gexec
COMMENT ON ROLE resume_studio_checkpoint IS 'resume-studio:s1.3:checkpoint';
COMMENT ON ROLE resume_studio_checkpoint_setup IS 'resume-studio:s1.3:checkpoint';
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('resume_studio_checkpoint', 'resume_studio_checkpoint_setup')
      AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) <> 2
      OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname IN ('resume_studio_checkpoint', 'resume_studio_checkpoint_setup')) THEN
    RAISE EXCEPTION 'Unexpected checkpoint role privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
      WHERE d.datname = 'resume_studio_s12_test' AND r.rolname = 'resume_studio_test') THEN
    RAISE EXCEPTION 'Provision the diagnostic database first';
  END IF;
END $$;
SELECT 'CREATE DATABASE resume_studio_checkpoint OWNER resume_studio_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'resume_studio_checkpoint')\gexec
COMMENT ON DATABASE resume_studio_checkpoint IS 'resume-studio:s1.3:checkpoint';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
      WHERE d.datname = 'resume_studio_checkpoint' AND r.rolname = 'resume_studio_owner') THEN
    RAISE EXCEPTION 'Unexpected checkpoint database owner';
  END IF;
END $$;
REVOKE ALL ON DATABASE resume_studio_checkpoint FROM PUBLIC;
REVOKE ALL ON DATABASE resume_studio_checkpoint FROM resume_studio_test;
REVOKE ALL ON DATABASE resume_studio_checkpoint FROM resume_studio_checkpoint;
GRANT CONNECT, CREATE ON DATABASE resume_studio_checkpoint TO resume_studio_checkpoint_setup;
GRANT CONNECT ON DATABASE resume_studio_checkpoint TO resume_studio_checkpoint;
REVOKE CONNECT ON DATABASE resume_studio_s12_test FROM PUBLIC, resume_studio_checkpoint, resume_studio_checkpoint_setup;
GRANT CONNECT ON DATABASE resume_studio_s12_test TO resume_studio_test;
\connect resume_studio_checkpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS langgraph AUTHORIZATION resume_studio_checkpoint_setup;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
      WHERE n.nspname = 'langgraph' AND r.rolname = 'resume_studio_checkpoint_setup') THEN
    RAISE EXCEPTION 'Unexpected checkpoint schema owner';
  END IF;
END $$;
REVOKE ALL ON SCHEMA langgraph FROM PUBLIC;
GRANT USAGE ON SCHEMA langgraph TO resume_studio_checkpoint;
`;
  await new Promise<void>((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', id, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
      '-U', 'resume_studio_owner', '-d', 'postgres'], { timeout: 30_000 }, error => {
      if (error) reject(new Error('Checkpoint provisioning failed; credentials were not logged.'));
      else resolve();
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(sql);
  });
}

export async function setupCheckpoint(config: CheckpointConfig, setupUrl: string): Promise<void> {
  await ownedPostgres();
  const pool = createCheckpointPool(setupUrl, 1);
  // A dedicated session serializes explicit setup commands. Leave migration execution
  // to the official saver rather than wrapping or copying its SQL into Prisma.
  const lockPool = createCheckpointPool(setupUrl, 1);
  let lockClient: PoolClient | undefined;
  try {
    lockClient = await lockPool.connect();
    await lockClient.query('SET lock_timeout = 5000');
    await lockClient.query('SELECT pg_advisory_lock(7313, 1)');
    await new PostgresSaver(pool, undefined, { schema: config.schema }).setup();
    await pool.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON
        langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes
        TO resume_studio_checkpoint;
      GRANT SELECT ON langgraph.checkpoint_migrations TO resume_studio_checkpoint;
    `);
  } finally {
    lockClient?.release(true);
    await Promise.all([lockPool.end(), pool.end()]);
  }
}
