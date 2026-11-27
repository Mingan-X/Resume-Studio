import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { generateEvaluationDataset } from '../../modules/evaluation/dataset.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

try {
  const [output] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
  const dataset = generateEvaluationDataset();
  await writeFile(output, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ code: 'EVALUATION_DATASET_CREATED', version: dataset.version,
    datasetHash: requestHash(dataset), resumes: dataset.resumes.length, jobs: dataset.jobs.length,
    annotationStatus: dataset.annotationStatus }));
} catch { console.error(JSON.stringify({ code: 'EVALUATION_DATASET_FAILED' })); process.exitCode = 1; }
