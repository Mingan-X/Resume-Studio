import {z} from 'zod';
import {taskApiConfigSchema} from '../config/task-api-config.js';
export const authConfigSchema=z.object({databaseUrl:taskApiConfigSchema.unwrap().shape.databaseUrl,origin:z.url().refine(value=>{
 const url=new URL(value);return url.origin===value&&!url.username&&!url.password&&url.protocol==='https:';
}),sessionSeconds:z.int().min(300).max(86400).default(28800),anonymousSeconds:z.int().min(60).max(900).default(600),
 sourceRequestsPerMinute:z.int().min(10).max(10000).default(600),authRequestsPerMinute:z.int().min(5).max(120).default(30),
 ownerRequestsPerMinute:z.int().min(5).max(1000).default(120),
}).strict();
export type AuthConfig=z.infer<typeof authConfigSchema>;
export const AUTH_CONFIG=Symbol('AUTH_CONFIG');
export const sessionCookieName='__Host-resume_session';
