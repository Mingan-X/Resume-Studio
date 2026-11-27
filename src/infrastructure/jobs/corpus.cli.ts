import 'reflect-metadata';
import { z } from 'zod';
import { open } from 'node:fs/promises';
import { DatabaseService } from '../database/database.service.js';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { jobIndexTargetSchema } from '../../contracts/job-publication.js';
import { JobRepository } from './job.repository.js';
import { JobPublicationRepository } from './publication.repository.js';
import { JobCorpusRepository } from './corpus.repository.js';
import { JobPublicationService } from '../../modules/jobs/job-publication.service.js';
import { CorpusImportService } from '../../modules/recall/corpus-import.service.js';
import { generateSyntheticJobs } from '../../modules/recall/synthetic-corpus.js';

let database: DatabaseService | undefined;
try {
  const [mode, ownerId] = z.tuple([z.enum(['generate', 'import']), z.uuid()]).parse(process.argv.slice(2));
  if (mode === 'generate') console.log(JSON.stringify(generateSyntheticJobs(ownerId), null, 2));
  else {
    // No default target: the operator supplies a real, versioned deployment configuration.
    const file = await open(z.string().min(1).parse(process.env.JOB_INDEX_TARGET_FILE), 'r');
    let raw: unknown;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) throw new Error('INDEX_TARGET_FILE_LIMIT');
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 65536) throw new Error('INDEX_TARGET_FILE_LIMIT');
      raw = JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
    } finally { await file.close(); }
    const target = jobIndexTargetSchema.parse(raw);
    if ([target.embeddingVersion, target.indexVersion, target.componentVersion].some(value => /fixture|synthetic|test-only/i.test(value))) {
      throw new Error('OFFICIAL_INDEX_TARGET_REQUIRED');
    }
    await ownedPostgres();
    database = new DatabaseService(loadInfrastructureConfig(process.env));
    const identity = { getOwnerId: () => Promise.resolve(ownerId) };
    const service = new CorpusImportService(identity, new JobRepository(database),
      new JobPublicationService(identity, new JobPublicationRepository(database), target), new JobCorpusRepository(database));
    const result = await service.importSynthetic();
    console.log(JSON.stringify({ code: 'CORPUS_IMPORTED', version: result.manifest.version,
      count: result.manifest.members.length, contentHash: result.contentHash, replay: result.replay }));
  }
} catch {
  console.error(JSON.stringify({ code: 'CORPUS_COMMAND_FAILED' })); process.exitCode = 1;
} finally { await database?.onModuleDestroy(); }
