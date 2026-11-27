import 'reflect-metadata';
import {AuthRepository} from './auth.repository.js';
import {DatabaseService} from '../database/database.service.js';
import {loadInfrastructureConfig} from '../config.js';
import {ownedPostgres} from '../checkpoint/ownership.js';
import {usernameSchema} from '../../contracts/auth.js';
let database:DatabaseService|undefined;
const chunks:Buffer[]=[];let bytes:Buffer|undefined;
try{
 const username=usernameSchema.parse(process.argv[2]);if(process.argv.length!==3||process.stdin.isTTY)throw new Error('PASSWORD_STDIN_REQUIRED');
 let length=0;for await(const chunk of process.stdin){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));chunks.push(part);length+=part.length;if(length>1026)throw new Error('PASSWORD_TOO_LONG');}
 bytes=Buffer.concat(chunks);const password=bytes.toString('utf8').replace(/\r?\n$/,'');await ownedPostgres();database=new DatabaseService(loadInfrastructureConfig(process.env));
 const account=await new AuthRepository(database).createAccount(username,password);
 console.log(JSON.stringify({code:'ACCOUNT_CREATED',username:account.username,ownerId:account.ownerId}));
}catch{console.error(JSON.stringify({code:'ACCOUNT_COMMAND_FAILED'}));process.exitCode=1;}finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);await database?.onModuleDestroy();}
