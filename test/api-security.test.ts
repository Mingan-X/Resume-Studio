import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Test} from '@nestjs/testing';
import {Controller,Post,Get} from '@nestjs/common';
import {ApiModule} from '../src/app-api.module.js';
import {apiConfigSchema} from '../src/modules/config/app-config.js';
import {configureHttp} from '../src/bootstrap-api.js';
import {RequestLimits} from '../src/infrastructure/http/api-security.js';
import {errorResponseSchema} from '../src/contracts/http.js';
import {AuthModule} from '../src/modules/auth/auth.module.js';
import {AuthRepository} from '../src/infrastructure/tasks/auth.repository.js';
import {createSessionToken,sessionCookie} from '../src/modules/auth/session-token.js';
import {randomUUID} from 'node:crypto';

@Controller('api/v1/test-security')
class SecurityFixture {
  @Get()get(){return {ok:true};}
  @Post()post(){return {ok:true};}
}
await test('request windows isolate owners, bound cardinality and expire without unbounded allocation',()=>{
  const limits=new RequestLimits(2);assert.equal(limits.take('a',1,0),true);assert.equal(limits.take('a',1,1),false);
  assert.equal(limits.take('b',1,1),true);assert.equal(limits.take('c',1,2),false);
  assert.equal(limits.take('c',1,60001),true);assert.equal(limits.take('a',1,60002),true);
});
await test('HTTP session guard counts each authenticated owner independently',async t=>{
  const config=apiConfigSchema.parse({role:'api',APP_ENV:'production',HTTP_PORT:'3000',auth:{databaseUrl:'postgresql://resume_studio_test:synthetic@127.0.0.1:55432/resume_studio_s12_test',origin:'https://resume.example',ownerRequestsPerMinute:5}});
  const a=createSessionToken(),b=createSessionToken(),ownerA=randomUUID(),ownerB=randomUUID();
  const module=await Test.createTestingModule({imports:[ApiModule.register(config,[AuthModule.register(config.auth,true)])],controllers:[SecurityFixture]})
    .overrideProvider(AuthRepository).useValue({session:async(token:string)=>[a,b].includes(token)?{token,account:{ownerId:token===a?ownerA:ownerB}}:null}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);t.after(()=>app.close());await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  for(let i=0;i<5;i++){const response=await fetch(`${base}/api/v1/test-security`,{headers:{cookie:sessionCookie(a,300)}});assert.equal(response.status,200);await response.body?.cancel();}
  const denied=await fetch(`${base}/api/v1/test-security`,{headers:{cookie:sessionCookie(a,300)}});assert.equal(denied.status,429);assert.equal(errorResponseSchema.parse(await denied.json()).code,'RATE_LIMITED');
  const other=await fetch(`${base}/api/v1/test-security`,{headers:{cookie:sessionCookie(b,300)}});assert.equal(other.status,200);await other.body?.cancel();
});
await test('real HTTP enforces source limits, ignores forged proxy headers, bounds JSON and preserves health',async t=>{
  const config=apiConfigSchema.parse({role:'api',APP_ENV:'production',HTTP_PORT:'3000',auth:{databaseUrl:'postgresql://resume_studio_test:synthetic@127.0.0.1:55432/resume_studio_s12_test',origin:'https://resume.example',sourceRequestsPerMinute:10}});
  const module=await Test.createTestingModule({imports:[ApiModule.register(config)],controllers:[SecurityFixture]}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);t.after(()=>app.close());await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const huge=await fetch(`${base}/api/v1/test-security`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'x'.repeat(1024*1024)})});
  assert.equal(huge.status,413);assert.equal(errorResponseSchema.parse(await huge.json()).code,'PAYLOAD_TOO_LARGE');
  for(let i=0;i<9;i++){const response=await fetch(`${base}/api/v1/test-security`,{headers:{'x-forwarded-for':`192.0.2.${i}`}});assert.equal(response.status,200);await response.body?.cancel();}
  const limited=await fetch(`${base}/api/v1/test-security`);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
  assert.equal(errorResponseSchema.parse(await limited.json()).code,'RATE_LIMITED');
  const health=await fetch(`${base}/health`);assert.equal(health.status,200);await health.body?.cancel();
  assert.equal(health.headers.get('x-content-type-options'),'nosniff');assert.equal(health.headers.get('x-frame-options'),'DENY');
  assert.equal(health.headers.get('strict-transport-security'),'max-age=31536000');assert.equal(health.headers.get('access-control-allow-origin'),null);
});
