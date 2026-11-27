import 'reflect-metadata';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { loadInfrastructureConfig } from '../config.js';
import { ownedPostgres } from '../checkpoint/ownership.js';
import { ScoringPolicyRepository } from './scoring-policy.repository.js';
import { defaultScoringPolicy } from '../../modules/scoring/default-policy.js';

let database: DatabaseService | undefined;
try {
  const [mode, ownerId] = z.tuple([z.literal('import-default'), z.uuid()]).parse(process.argv.slice(2));
  await ownedPostgres(); database = new DatabaseService(loadInfrastructureConfig(process.env));
  const result = await new ScoringPolicyRepository(database).import(ownerId, defaultScoringPolicy);
  console.log(JSON.stringify({ code: 'SCORING_POLICY_IMPORTED', mode, version: result.content.version, hash: result.contentHash, replay: result.replay }));
} catch { console.error(JSON.stringify({ code: 'SCORING_POLICY_COMMAND_FAILED' })); process.exitCode = 1; }
finally { await database?.onModuleDestroy(); }
