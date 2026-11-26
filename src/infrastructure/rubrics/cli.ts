import 'reflect-metadata';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { JobRepository } from '../jobs/job.repository.js';
import { RubricService } from '../../modules/rubrics/rubric.service.js';

let database: DatabaseService | undefined;
try {
  const [mode, owner, argument] = z.tuple([z.enum(['import', 'load']), z.uuid(), z.string().min(1)]).parse(process.argv.slice(2));
  const config = loadInfrastructureConfig(process.env);
  await ownedPostgres();
  database = new DatabaseService(config);
  const service = new RubricService({ getOwnerId: () => Promise.resolve(owner) }, new JobRepository(database));
  if (mode === 'import') {
    const file = await open(argument, 'r');
    let content: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('RUBRIC_FILE_LIMIT');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      if (size > 1024 * 1024) throw new Error('RUBRIC_FILE_LIMIT');
      content = JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
    } finally { await file.close(); }
    console.log(JSON.stringify({ code: 'RUBRIC_IMPORTED', ...await service.import(content) }));
  } else {
    const result = await service.load(argument);
    console.log(JSON.stringify({ code: 'RUBRIC_LOADED', version: result.content.version, contentHash: result.contentHash,
      dimensions: result.content.dimensions.length, levels: result.content.dimensions.reduce((sum, dimension) => sum + dimension.levels.length, 0),
      reviewStatus: result.content.reviewStatus }));
  }
} catch {
  console.error(JSON.stringify({ code: 'RUBRIC_COMMAND_FAILED' })); process.exitCode = 1;
} finally { await database?.onModuleDestroy(); }
