import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {passwordSchema} from '../../contracts/auth.js';
const encodedSchema=z.string().regex(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,Buffer.from(salt,'hex'),64,
 {N:131072,r:8,p:1,maxmem:160*1024*1024},(error,key)=>error?reject(error):resolve(key)));
let active=0;
async function bounded(password:string,salt:string){if(active>=2)throw new Error('PASSWORD_HASH_BUSY');active++;try{return await derive(password,salt);}finally{active--;}}
export async function hashPassword(raw:unknown){const password=passwordSchema.parse(raw),salt=randomBytes(16).toString('hex');return encodedSchema.parse(`scrypt-v1$${salt}$${(await bounded(password,salt)).toString('hex')}`);}
export async function verifyPassword(raw:unknown,stored:string|null){const password=passwordSchema.parse(raw);
 const value=encodedSchema.parse(stored??`scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`),[,salt='',hash='']=value.split('$');
 const actual=await bounded(password,salt);return timingSafeEqual(actual,Buffer.from(hash,'hex'))&&stored!==null;}
