import { Pool } from 'pg';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { LocalStorage } from './local-storage.js';

let pool: Pool | undefined;
try {
  if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== 'reconcile') throw new Error('arguments');
  const root = z.string().min(1).refine(isAbsolute).parse(process.env.STORAGE_ROOT);
  const config = loadInfrastructureConfig(process.env);
  await ownedPostgres();
  pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  // T3 supplies the table. Missing schema must never be interpreted as no references.
  await pool.query('SELECT storage_key FROM file_asset LIMIT 0');
  const database = pool;
  const storage = await LocalStorage.create(root);
  const result = await storage[process.argv[2] === 'reconcile' ? 'reconcileUploads' : 'reclaim'](new Date(Date.now() - 24 * 60 * 60 * 1000), {
    isReferenced: async key => {
      const result = await database.query('SELECT EXISTS(SELECT 1 FROM file_asset WHERE storage_key = $1::uuid) AS referenced', [key]);
      return z.array(z.object({ referenced: z.boolean() })).length(1).parse(result.rows)[0]?.referenced !== false;
    },
  });
  process.stdout.write(JSON.stringify({ code: 'STORAGE_RECLAIMED', removed: result.removed.length, retained: result.retained.length }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ code: 'STORAGE_RECLAIM_FAILED' }) + '\n');
  process.exitCode = 1;
} finally { await pool?.end(); }
