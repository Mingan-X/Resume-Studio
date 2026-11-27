import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApi } from '../../src/bootstrap-api.js';
import { loadConfig } from '../../src/modules/config/app-config.js';
import { AuthRepository } from '../../src/infrastructure/tasks/auth.repository.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { loadInfrastructureConfig } from '../../src/infrastructure/config.js';
import { ownedPostgres } from '../../src/infrastructure/checkpoint/ownership.js';
import { authSessionResponseSchema, authMeResponseSchema } from '../../src/contracts/auth.js';
import { jobVersionResponseSchema, jobListResponseSchema } from '../../src/contracts/job-api.js';
import { readSessionCookie, tokenHash } from '../../src/modules/auth/session-token.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {syntheticPdf} from '../support/document-fixtures.js';
import {resumeVersionResponseSchema} from '../../src/contracts/resumes.js';
import {TaskRepository} from '../../src/infrastructure/tasks/task.repository.js';
import {analysisInput} from '../support/task-inputs.js';
import {deletionResponseSchema} from '../../src/contracts/lifecycle.js';

await test('S3.2 session identity isolates concurrent owners and protects every business controller in production assembly', {timeout:90000}, async t=>{
  await ownedPostgres(); const connection=loadInfrastructureConfig(process.env), origin='https://resume.example';
  const root=await mkdtemp(join(tmpdir(),'resume-auth-http-'));
  const app=await createApi(loadConfig('api',{APP_ENV:'production',HTTP_PORT:'3000',TASK_API_ENABLED:'true',JOB_API_ENABLED:'true',RESUME_API_ENABLED:'true',STORAGE_ROOT:root,
    AUTH_ENABLED:'true',AUTH_ORIGIN:origin,DATABASE_URL:connection.databaseUrl}));
  const db=app.get(DatabaseService).client, auth=app.get(AuthRepository), owners:string[]=[], tokens=new Set<string>();
  t.after(async()=>{try{await ownedPostgres();await db.$transaction(async tx=>{
    await tx.authSession.deleteMany({where:{tokenHash:{in:[...tokens]}}});
    const where={ownerId:{in:owners}};
    await tx.deletionRequest.deleteMany({where});
    await tx.outboxEvent.deleteMany({where});await tx.taskEvent.deleteMany({where});await tx.analysisTask.deleteMany({where});
    await tx.resumeUpload.deleteMany({where});await tx.extractedDocument.deleteMany({where});await tx.evidenceBlock.deleteMany({where});
    await tx.resumeVersion.deleteMany({where});await tx.resume.deleteMany({where});await tx.fileAsset.deleteMany({where});
    await tx.jobVersion.deleteMany({where:{ownerId:{in:owners}}});await tx.job.deleteMany({where:{ownerId:{in:owners}}});
    await tx.account.deleteMany({where:{ownerId:{in:owners}}});await tx.owner.deleteMany({where:{id:{in:owners}}});
  });}finally{await app.close();assert.equal(relative(resolve(tmpdir()),resolve(root)).startsWith('..'),false);await rm(root,{recursive:true});}});
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const consume=async(response:Response)=>{await response.body?.cancel();return response.status;};
  assert.equal(await consume(await fetch(`${base}/health`)),200);
  for(const path of ['/resumes','/jobs','/analyses','/analyses/options','/reports',`/tasks/${randomUUID()}`,`/tasks/${randomUUID()}/events`]) {
    assert.equal(await consume(await fetch(`${base}/api/v1${path}`,{headers:{'x-owner-id':randomUUID()}})),401,path);
  }
  const login=async()=>{
    const password='synthetic-session-password-123',account=await auth.createAccount(`test-${randomUUID()}`,password);owners.push(account.ownerId);
    const response=await fetch(`${base}/api/v1/auth/session`),session=authSessionResponseSchema.parse(await response.json()),cookie=response.headers.get('set-cookie')!;
    tokens.add(tokenHash(readSessionCookie(cookie)!));
    const logged=await fetch(`${base}/api/v1/auth/login`,{method:'POST',headers:{cookie,origin,'x-csrf-token':session.csrfToken,'content-type':'application/json'},body:JSON.stringify({username:account.username,password})});
    assert.equal(logged.status,200);const active=authMeResponseSchema.parse(await logged.json()),activeCookie=logged.headers.get('set-cookie')!;
    tokens.add(tokenHash(readSessionCookie(activeCookie)!));return {cookie:activeCookie,csrf:active.csrfToken,owner:account.ownerId};
  };
  const a=await login(),b=await login(),body={title:'Synthetic session job',city:null,level:null,skills:[],body:'Synthetic job only'};
  const headers=(user:typeof a)=>({cookie:user.cookie,origin,'x-csrf-token':user.csrf,'content-type':'application/json'});
  assert.equal(await consume(await fetch(`${base}/api/v1/jobs`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify(body)})),403);
  const created=await fetch(`${base}/api/v1/jobs`,{method:'POST',headers:{...headers(a),'x-owner-id':b.owner},body:JSON.stringify(body)});
  assert.equal(created.status,201);const job=jobVersionResponseSchema.parse(await created.json());
  assert.equal((await db.job.findUniqueOrThrow({where:{id:job.jobId}})).ownerId,a.owner);
  await Promise.all([a,b,a,b].map(async user=>{
    const list=jobListResponseSchema.parse(await (await fetch(`${base}/api/v1/jobs`,{headers:headers(user)})).json());
    assert.equal(list.items.length,user===a?1:0);
  }));
  assert.equal(await consume(await fetch(`${base}/api/v1/jobs/${job.jobId}`,{headers:headers(b)})),404);
  const versionPath=`${base}/api/v1/jobs/${job.jobId}/versions/${job.id}`;
  assert.equal(await consume(await fetch(versionPath,{headers:headers(b)})),404);
  for(const [suffix,method,input] of [['','PATCH',{kind:'body',body:'Attempted foreign edit'}],['/confirm','POST',{hardRequirementsConfirmed:true,weightsConfirmed:true}],['/publish','POST',{}],['/suggestions','POST',{}]] as const){
    assert.equal(await consume(await fetch(versionPath+suffix,{method,headers:{...headers(b),'idempotency-key':randomUUID()},body:JSON.stringify(input)})),404,suffix);
  }
  const form=new FormData();form.set('file',new Blob([new Uint8Array(syntheticPdf([{text:'Synthetic private resume'}]))],{type:'application/pdf'}),'resume.pdf');
  const upload=await fetch(`${base}/api/v1/resumes`,{method:'POST',headers:{cookie:a.cookie,origin,'x-csrf-token':a.csrf,'idempotency-key':randomUUID()},body:form});
  assert.equal(upload.status,201);const resume=resumeVersionResponseSchema.parse(await upload.json());
  assert.equal(await consume(await fetch(`${base}/api/v1/resumes/${resume.resumeId}/versions/${resume.resumeVersionId}`,{headers:headers(b)})),404);
  assert.deepEqual(await (await fetch(`${base}/api/v1/resumes`,{headers:headers(b)})).json(),{items:[],nextCursor:null});
  const task=await new TaskRepository(app.get(DatabaseService)).createAnalysis(randomUUID(),{...analysisInput(),ownerId:a.owner});
  for(const path of [`/tasks/${task.taskId}`,`/tasks/${task.taskId}/events`])assert.equal(await consume(await fetch(`${base}/api/v1${path}`,{headers:headers(b)})),404);
  assert.equal(await consume(await fetch(`${base}/api/v1/tasks/${task.taskId}/cancel`,{method:'POST',headers:headers(b),body:'{}'})),404);
  assert.equal((await db.analysisTask.findUniqueOrThrow({where:{id:task.taskId}})).cancelRequested,false);
  assert.equal(await consume(await fetch(`${base}/api/v1/jobs`,{method:'POST',headers:headers(a),body:JSON.stringify({...body,ownerId:b.owner})})),400);
  const deleteKey=randomUUID(),deleteHeaders={...headers(a),'idempotency-key':deleteKey};
  const deletion=await fetch(`${base}/api/v1/data-deletions`,{method:'POST',headers:deleteHeaders,body:'{}'});assert.equal(deletion.status,202);
  const pending=deletionResponseSchema.parse(await deletion.json());assert.equal(pending.status,'WAITING');
  const duplicate=await fetch(`${base}/api/v1/data-deletions`,{method:'POST',headers:deleteHeaders,body:'{}'});assert.equal(duplicate.status,202);assert.equal(deletionResponseSchema.parse(await duplicate.json()).id,pending.id);
  assert.equal(await consume(await fetch(`${base}/api/v1/data-deletions/${pending.id}`,{headers:headers(b)})),404);
  assert.equal(await consume(await fetch(`${base}/api/v1/data-deletions/${pending.id}`,{headers:headers(a)})),200);
  assert.equal(await consume(await fetch(`${base}/api/v1/jobs`,{method:'POST',headers:headers(a),body:JSON.stringify(body)})),409);
  await db.authSession.update({where:{tokenHash:tokenHash(readSessionCookie(a.cookie)!)},data:{expiresAt:new Date(0)}});
  assert.equal(await consume(await fetch(`${base}/api/v1/jobs`,{headers:headers(a)})),401);
});
