import {Injectable,UnauthorizedException,ServiceUnavailableException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DatabaseService} from '../database/database.service.js';
import {usernameSchema} from '../../contracts/auth.js';
import {hashPassword,verifyPassword} from '../../modules/auth/password.js';
import {createSessionToken,tokenHash} from '../../modules/auth/session-token.js';
@Injectable()
export class AuthRepository{
 constructor(private readonly database:DatabaseService){}
 async createAccount(username:unknown,password:unknown){const name=usernameSchema.parse(username),passwordHash=await hashPassword(password),id=randomUUID(),ownerId=randomUUID();
  await this.database.client.$transaction(async tx=>{await tx.owner.create({data:{id:ownerId}});await tx.account.create({data:{id,ownerId,username:name,passwordHash}});});return {id,ownerId,username:name};}
 async createAnonymous(seconds:number){const token=createSessionToken();return this.database.client.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(7322,1)::text`;
  await tx.$executeRaw`DELETE FROM auth_session WHERE token_hash IN (SELECT token_hash FROM auth_session WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)`;
  if(await tx.authSession.count({where:{accountId:null}})>=10000)throw new ServiceUnavailableException();
  const now=z.array(z.object({now:z.date()})).length(1).parse(await tx.$queryRaw`SELECT clock_timestamp() AS now`)[0]!.now;
  const expiresAt=new Date(now.getTime()+z.int().min(60).max(900).parse(seconds)*1000);
  await tx.authSession.create({data:{tokenHash:tokenHash(token),expiresAt}});return {token,expiresAt};});}
 async session(token:string){const row=await this.database.client.authSession.findUnique({where:{tokenHash:tokenHash(token)},include:{account:true}});
  if(!row||row.expiresAt<=new Date()||row.account&&!row.account.enabled)return null;
  return {token,expiresAt:row.expiresAt,account:row.account?{id:row.account.id,ownerId:row.account.ownerId,username:row.account.username}:null};}
 async login(token:string,username:unknown,password:unknown,seconds:number){const name=usernameSchema.parse(username),account=await this.database.client.account.findUnique({where:{username:name}});
  let valid=false;try{valid=await verifyPassword(password,account?.passwordHash??null);}catch(error){if(error instanceof Error&&error.message==='PASSWORD_HASH_BUSY')throw new ServiceUnavailableException();throw error;}
  const nextToken=createSessionToken();
  const result=await this.database.client.$transaction(async tx=>{
   if(!account)return null;
   await tx.$queryRaw`SELECT id FROM account WHERE id=${account.id}::uuid FOR UPDATE`;
   const fresh=await tx.account.findUniqueOrThrow({where:{id:account.id}});
   const now=z.array(z.object({now:z.date()})).length(1).parse(await tx.$queryRaw`SELECT clock_timestamp() AS now`)[0]!.now;
   const session=await tx.authSession.findUnique({where:{tokenHash:tokenHash(token)}});
   if(!session||session.expiresAt<=now||!fresh.enabled||fresh.passwordHash!==account.passwordHash||fresh.lockedUntil&&fresh.lockedUntil>now)return null;
   if(!valid){const attempts=fresh.lockedUntil&&fresh.lockedUntil<=now?1:fresh.failedAttempts+1;await tx.account.update({where:{id:fresh.id},data:{failedAttempts:attempts,lockedUntil:attempts>=5?new Date(now.getTime()+15*60*1000):null}});return null;}
   const deleted=await tx.authSession.deleteMany({where:{tokenHash:tokenHash(token)}});if(deleted.count!==1)return null;
   await tx.account.update({where:{id:fresh.id},data:{failedAttempts:0,lockedUntil:null}});
   const expiresAt=new Date(now.getTime()+seconds*1000);await tx.authSession.create({data:{tokenHash:tokenHash(nextToken),accountId:fresh.id,expiresAt}});
   return {token:nextToken,expiresAt,account:{id:fresh.id,ownerId:fresh.ownerId,username:fresh.username}};
  });if(!result)throw new UnauthorizedException();return result;
 }
 async logout(token:string){await this.database.client.authSession.deleteMany({where:{tokenHash:tokenHash(token)}});}
}
