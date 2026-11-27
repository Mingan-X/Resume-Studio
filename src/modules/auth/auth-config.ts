import {z} from 'zod';
export const authConfigSchema=z.object({databaseUrl:z.url(),origin:z.url().refine(value=>{
 const url=new URL(value);return url.origin===value&&!url.username&&!url.password&&url.protocol==='https:';
}),sessionSeconds:z.int().min(300).max(86400).default(28800),anonymousSeconds:z.int().min(60).max(900).default(600),
}).strict();
export type AuthConfig=z.infer<typeof authConfigSchema>;
export const AUTH_CONFIG=Symbol('AUTH_CONFIG');
export const sessionCookieName='__Host-resume_session';
