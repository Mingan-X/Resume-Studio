import 'reflect-metadata';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { ownedQdrant } from '../vector/ownership.js';
import { JobIndexVector } from '../vector/job-index.vector.js';
import { JobCorpusRepository } from './corpus.repository.js';
import { JobPublicationRepository } from './publication.repository.js';
import { JobIndexRepository } from './index.repository.js';
import { jobIndexTargetSchema } from '../../contracts/job-publication.js';
import { indexCollectionSchema } from '../../contracts/job-index.js';
import { versionNameSchema } from '../../contracts/jobs.js';
import { indexBackfillKey } from '../../modules/recall/job-chunks.js';

async function readJson(path: string) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > 65536) throw new Error('INDEX_CONFIG_LIMIT');
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > 65536) throw new Error('INDEX_CONFIG_LIMIT');
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8')); return value;
  } finally { await file.close(); }
}

let database: DatabaseService | undefined;
try {
  const [mode, ownerId, corpusVersion, argument] = z.tuple([z.enum(['backfill', 'alias']), z.uuid(), versionNameSchema, z.string().min(1)])
    .parse(process.argv.slice(2));
  const config = loadInfrastructureConfig(process.env); await ownedPostgres(); database = new DatabaseService(config);
  if (mode === 'backfill') {
    const runId = z.uuid().parse(argument), target = jobIndexTargetSchema.parse(await readJson(z.string().min(1).parse(process.env.JOB_INDEX_TARGET_FILE)));
    if (target.chunkerVersion !== 'jd-chunks-v1' || target.componentVersion !== 'job-index-v1'
      || /fixture|synthetic|test-only/i.test(target.embeddingVersion)) throw new Error('OFFICIAL_INDEX_TARGET_REQUIRED');
    const corpus = await new JobCorpusRepository(database).load(ownerId, corpusVersion);
    if (!corpus) throw new Error('CORPUS_NOT_FOUND');
    const repository = new JobPublicationRepository(database);
    const deadline = Date.now() + 600_000; let created = 0;
    for (const member of corpus.manifest.members) {
      if (Date.now() >= deadline) throw new Error('BACKFILL_DEADLINE');
      const result = await repository.ensureIndex(ownerId, member.jobVersionId, indexBackfillKey(runId, member.jobVersionId), target);
      if (result.created) created++;
    }
    console.log(JSON.stringify({ code: 'INDEX_BACKFILL_SCHEDULED', corpusVersion, created, members: corpus.manifest.members.length }));
  } else {
    const spec = indexCollectionSchema.parse(await readJson(argument));
    if (spec.provenance !== 'bailian') throw new Error('OFFICIAL_EMBEDDING_REQUIRED');
    const ready = await new JobIndexRepository(database).assertCorpusReady(ownerId, corpusVersion, spec);
    const deadline = Date.now() + 60_000;
    await new JobIndexVector({ url: config.qdrantUrl, apiKey: config.qdrantApiKey }, ownedQdrant)
      .switchAlias(spec, { deadline, signal: AbortSignal.timeout(60_000) });
    console.log(JSON.stringify({ code: 'INDEX_ALIAS_SWITCHED', corpusVersion, collection: ready.collection }));
  }
} catch { console.error(JSON.stringify({ code: 'INDEX_COMMAND_FAILED' })); process.exitCode = 1; }
finally { await database?.onModuleDestroy(); }
