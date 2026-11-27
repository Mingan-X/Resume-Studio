import { isAbsolute } from 'node:path';
import { z } from 'zod';

try {
  const [mode] = z.tuple([z.enum(['consume', 'reconcile-once', 'reconcile-watch'])]).parse(process.argv.slice(2));
  z.enum(['development', 'test']).parse(process.env.APP_ENV);
  const modelPath = z.string().min(1).refine(isAbsolute).parse(process.env.ANALYSIS_MODEL_CONFIG_FILE);
  const embeddingPath = z.string().min(1).refine(isAbsolute).parse(process.env.JOB_EMBEDDING_CONFIG_FILE);
  const model = await (await import('../models/analysis-model-config.js')).loadAnalysisModel(modelPath);
  const embedding = await (await import('../models/embedding-config.js')).loadEmbeddingExecutor(embeddingPath);
  await (await import('./analysis-worker-runtime.js')).runAnalysisWorker(mode, model, embedding);
} catch { console.error(JSON.stringify({ code: 'ANALYSIS_RUNTIME_FAILED' })); process.exitCode = 1; }
