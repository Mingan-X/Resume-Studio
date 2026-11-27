import { isAbsolute } from 'node:path';
import { z } from 'zod';

try {
  const [mode] = z.tuple([z.enum(['consume', 'reconcile-once', 'reconcile-watch'])]).parse(process.argv.slice(2));
  z.enum(['development', 'test', 'production']).parse(process.env.APP_ENV);
  const path = z.string().min(1).refine(isAbsolute).parse(process.env.JOB_EMBEDDING_CONFIG_FILE);
  const embedding = await (await import('../models/embedding-config.js')).loadEmbeddingExecutor(path);
  // Invalid local configuration never loads Prisma/Nest or initializes infrastructure modules.
  await (await import('./index-worker-runtime.js')).runIndexWorker(mode, embedding);
} catch { console.error(JSON.stringify({ code: 'INDEX_RUNTIME_FAILED' })); process.exitCode = 1; }
