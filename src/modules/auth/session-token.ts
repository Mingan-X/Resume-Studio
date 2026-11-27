import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {ForbiddenException} from '@nestjs/common';
import {z} from 'zod';
import {sessionCookieName} from './auth-config.js';
export const sessionTokenSchema=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export const createSessionToken=()=>randomBytes(32).toString('base64url');
export const csrfFor=(token:string)=>createHmac('sha256',sessionTokenSchema.parse(token)).update('resume-studio-csrf-v1').digest('hex');
export function readSessionCookie(raw:string|undefined){if(!raw||raw.length>8192)return null;const values=raw.split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${sessionCookieName}=`));
 if(values.length!==1)return null;const token=values[0]!.slice(sessionCookieName.length+1),parsed=sessionTokenSchema.safeParse(token);return parsed.success?parsed.data:null;}
export function requireCsrf(token:string,raw:unknown,origin:unknown,expectedOrigin:string){const candidate=z.string().regex(/^[a-f0-9]{64}$/).safeParse(raw);
 if(origin!==expectedOrigin||!candidate.success||!timingSafeEqual(Buffer.from(candidate.data,'hex'),Buffer.from(csrfFor(token),'hex')))throw new ForbiddenException();}
export function sessionCookie(token:string,seconds:number){sessionTokenSchema.parse(token);return `${sessionCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;}
