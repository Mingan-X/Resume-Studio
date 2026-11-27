import 'reflect-metadata';
import {isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {loadInfrastructureConfig} from '../config.js';
import {DatabaseService} from '../database/database.service.js';
import {ownedPostgres} from '../checkpoint/ownership.js';
import {loadCheckpointConfig} from '../checkpoint/config.js';
import {LocalStorage} from '../storage/local-storage.js';
import {JobIndexVector} from '../vector/job-index.vector.js';
import {ownedQdrant} from '../vector/ownership.js';
import {LifecycleExecutor} from './lifecycle.executor.js';
import {LifecycleStorage} from './lifecycle.storage.js';
let db:DatabaseService|undefined;const abort=new AbortController(),stop=()=>abort.abort();
try{
 const [mode]=z.tuple([z.enum(['once','watch'])]).parse(process.argv.slice(2));
 const root=z.string().refine(isAbsolute).parse(process.env.STORAGE_ROOT),config=loadInfrastructureConfig(process.env);
 const traces=z.object({baseUrl:z.literal('http://127.0.0.1:53000'),publicKey:z.string().min(1),secretKey:z.string().min(1)}).parse({baseUrl:process.env.LANGFUSE_BASE_URL,publicKey:process.env.LANGFUSE_PUBLIC_KEY,secretKey:process.env.LANGFUSE_SECRET_KEY});
 await ownedPostgres();db=new DatabaseService(config);
 const executor=new LifecycleExecutor(db,new LifecycleStorage(await LocalStorage.create(root),new JobIndexVector({url:config.qdrantUrl,apiKey:config.qdrantApiKey},ownedQdrant),loadCheckpointConfig(process.env),traces,db));
 process.once('SIGINT',stop);process.once('SIGTERM',stop);let failures=0;
 do{
  try{console.log(JSON.stringify({code:'LIFECYCLE_CYCLE',...await executor.once(abort.signal)}));failures=0;}
  catch{if(abort.signal.aborted)break;if(++failures>=3||mode==='once')throw new Error('LIFECYCLE_CYCLE_FAILED');console.error(JSON.stringify({code:'LIFECYCLE_CYCLE_FAILED'}));}
  if(mode==='once')break;await delay(60000,undefined,{signal:abort.signal}).catch(()=>{});
 }while(!abort.signal.aborted);
}catch{console.error(JSON.stringify({code:'LIFECYCLE_FAILED'}));process.exitCode=1;}
finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await db?.onModuleDestroy();}
