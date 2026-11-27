import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { taskResponseSchema } from '../src/contracts/task-api.js';

const execute = promisify(execFile);
await test('OpenAPI artifact is deterministic and stale/missing copies fail without rewriting them', async () => {
  const original = await readFile('docs/openapi.json','utf8');
  const valid = await execute(process.execPath,['scripts/openapi.mjs','--check'],{timeout:15000});
  assert.match(valid.stdout,/matches runtime schemas/);
  const directory = await mkdtemp(join(tmpdir(),'resume-openapi-'));
  try {
    const path=join(directory,'stale.json');await writeFile(path,'{}\n');
    await assert.rejects(execute(process.execPath,['scripts/openapi.mjs','--check',path],{timeout:15000}),
      (error:unknown)=>{const result=z.object({code:z.literal(1),stderr:z.string()}).parse(error);assert.match(result.stderr,/OPENAPI_STALE/);return true;});
    assert.equal(await readFile(path,'utf8'),'{}\n');
    await assert.rejects(execute(process.execPath,['scripts/openapi.mjs','--check',join(directory,'missing.json')],{timeout:15000}),
      (error:unknown)=>z.object({code:z.literal(1)}).safeParse(error).success);
    assert.equal(await readFile('docs/openapi.json','utf8'),original);
  } finally {await rm(join(directory,'stale.json'),{force:true});await rmdir(directory);}
});

await test('published contract includes actual HTTP operations and distinct task statuses without internal fields',async()=>{
  const document=z.object({openapi:z.literal('3.1.0'),paths:z.record(z.string(),z.record(z.string(),z.unknown())),
    components:z.object({schemas:z.record(z.string(),z.unknown())})}).parse(JSON.parse(await readFile('docs/openapi.json','utf8')) as unknown);
  assert.deepEqual(Object.keys(document.paths).sort(),['/api/v1/analyses','/api/v1/analyses/options','/api/v1/analyses/{taskId}','/api/v1/auth/login','/api/v1/auth/logout','/api/v1/auth/me','/api/v1/auth/session','/api/v1/jobs','/api/v1/jobs/{jobId}','/api/v1/jobs/{jobId}/versions/{versionId}','/api/v1/jobs/{jobId}/versions/{versionId}/confirm','/api/v1/jobs/{jobId}/versions/{versionId}/publish','/api/v1/jobs/{jobId}/versions/{versionId}/suggestions','/api/v1/reports','/api/v1/reports/{reportId}','/api/v1/reports/{reportId}/recompute','/api/v1/reports/{reportId}/revisions','/api/v1/resumes','/api/v1/resumes/{resumeId}/versions/{versionId}','/api/v1/tasks/{taskId}','/api/v1/tasks/{taskId}/cancel','/api/v1/tasks/{taskId}/events','/health']);
  assert.ok(document.paths['/api/v1/analyses']?.post);
  assert.ok(document.paths['/api/v1/tasks/{taskId}']?.get);assert.ok(document.paths['/api/v1/tasks/{taskId}/cancel']?.post);
  const output=JSON.stringify(document.components.schemas.TaskResponse);
  for(const forbidden of ['fenceToken','ownerId','inputSnapshot','activeGraphThreadId','leaseOwner'])assert.ok(!output.includes(forbidden));
  const sample={taskId:'00000000-0000-4000-8000-000000000001',taskType:'JOB_INDEX',status:'PARTIAL',stage:'FAILED',
    progress:{completed:0,total:null},attempt:0,nextRetryAt:null,error:null,reportId:null,cancelRequested:false};
  assert.equal(taskResponseSchema.safeParse(sample).success,false);
  assert.equal(taskResponseSchema.safeParse({...sample,taskType:'ANALYSIS'}).success,true);
  assert.equal(taskResponseSchema.safeParse({...sample,status:'QUEUED',progress:{completed:2,total:1}}).success,false);
});
