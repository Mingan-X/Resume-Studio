import {z} from 'zod';
export const deletionPathSchema=z.object({requestId:z.uuid()}).strict();
export const deletionResponseSchema=z.object({id:z.uuid(),scope:z.enum(['ALL','RESUME']),resumeVersionId:z.uuid().nullable(),
 status:z.enum(['WAITING','RUNNING','DONE']),reason:z.enum(['ACTIVE_EXECUTION','INCOMPLETE_HISTORY','STORAGE_UNAVAILABLE','RETRY_LIMIT']).nullable(),
 createdAt:z.iso.datetime(),completedAt:z.iso.datetime().nullable(),completedSteps:z.int().nonnegative(),totalSteps:z.int().nonnegative()}).strict();
export const deletionResourceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('FILE'),storageKey:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.int().positive()}).strict(),
 z.object({kind:z.literal('CHECKPOINT'),threadId:z.uuid()}).strict(),
 z.object({kind:z.literal('VECTOR'),ownerId:z.uuid()}).strict(),
 z.object({kind:z.literal('TRACE'),traceId:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),
]);
export type DeletionResource=z.infer<typeof deletionResourceSchema>;
