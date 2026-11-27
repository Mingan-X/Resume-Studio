import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lastEventIdSchema} from '../src/contracts/analysis-api.js';
import {decodePage} from '../src/infrastructure/tasks/report.repository.js';
import {EventStreamLimits} from '../src/modules/tasks/task-events.controller.js';
import {recomputeRequestSchema} from '../src/contracts/reports.js';
await test('S3.1 cursor/event IDs and recompute boundaries reject malformed or unknown fields',()=>{
 for(const value of ['-1','1.5','01','2147483648','x'])assert.equal(lastEventIdSchema.safeParse(value).success,false);
 assert.equal(lastEventIdSchema.parse('123'),123);assert.throws(()=>decodePage({cursor:'invalid'}));
 assert.equal(recomputeRequestSchema.safeParse({weights:[]}).success,false);assert.equal(recomputeRequestSchema.safeParse({weights:[],ownerId:'forbidden'}).success,false);
});
await test('S3.1 stream connection slots release exactly once and isolate per-owner quotas',()=>{
 const limits=new EventStreamLimits(),releases=Array.from({length:5},()=>limits.acquire('owner1'));assert.throws(()=>limits.acquire('owner1'));
 const other=limits.acquire('owner2');releases[0]!();releases[0]!();const reused=limits.acquire('owner1');assert.throws(()=>limits.acquire('owner1'));
 reused();other();for(const release of releases)release();for(let i=0;i<100;i++){const release=limits.acquire('owner1');release();}
});
