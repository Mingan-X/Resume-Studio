import {z} from 'zod';
export const usernameSchema=z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const passwordSchema=z.string().min(15).max(256).refine(value=>Buffer.byteLength(value,'utf8')<=1024);
export const loginRequestSchema=z.object({username:usernameSchema,password:passwordSchema}).strict();
export const authUserSchema=z.object({id:z.uuid(),username:usernameSchema}).strict();
export const authSessionResponseSchema=z.object({user:authUserSchema.nullable(),csrfToken:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.iso.datetime()}).strict();
export const authMeResponseSchema=authSessionResponseSchema.safeExtend({user:authUserSchema});
export const logoutResponseSchema=z.object({loggedOut:z.literal(true)}).strict();
