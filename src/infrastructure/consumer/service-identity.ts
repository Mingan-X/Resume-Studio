import { AsyncLocalStorage } from 'node:async_hooks';
import { DEVELOPMENT_OWNER_ID, ownerIdSchema } from '../../modules/identity/identity.module.js';
import type { IdentityPort } from '../../modules/identity/identity.module.js';
import type { DatabaseService } from '../database/database.service.js';
import { taskDispatchSchema } from '../../contracts/tasks.js';
import type { TaskDispatch } from '../../contracts/tasks.js';
import { requestHash } from '../../modules/tasks/request-hash.js';
import { RejectedTaskDelivery } from './contracts.js';
import { dispatchFromClaim } from '../outbox/outbox.publisher.js';

// Infrastructure-only principal: poison envelopes cannot choose a user's quarantine scope.
export const INFRASTRUCTURE_OWNER_ID='00000000-0000-4000-8000-000000000002';
export const infrastructureIdentity:IdentityPort={getOwnerId:()=>Promise.resolve(INFRASTRUCTURE_OWNER_ID)};
export class ServiceIdentity implements IdentityPort {
  private readonly owners=new AsyncLocalStorage<string>();
  getOwnerId():Promise<string>{const owner=this.owners.getStore();if(!owner)throw new Error('TRUSTED_OWNER_REQUIRED');return Promise.resolve(owner);}
  run<T>(owner:string,action:()=>Promise<T>):Promise<T>{return this.owners.run(ownerIdSchema.parse(owner),action);}
}

export class PersistedDeliveryRouter {
  constructor(private readonly database:DatabaseService,private readonly identity:ServiceIdentity,
    private readonly handler:{handle(message:TaskDispatch,signal:AbortSignal):Promise<'ack'|'deferred'>},private readonly production:boolean){}
  async handle(input:TaskDispatch,signal:AbortSignal):Promise<'ack'|'deferred'>{
    signal.throwIfAborted();const message=taskDispatchSchema.parse(input);
    const event=await this.database.client.outboxEvent.findUnique({where:{eventId:message.messageId}});
    if(!event)throw new RejectedTaskDelivery('TASK_NOT_AVAILABLE');
    let expected:TaskDispatch;
    try{expected=dispatchFromClaim(event);}catch{throw new RejectedTaskDelivery('MESSAGE_ID_REUSED');}
    if(requestHash(expected)!==requestHash(message))throw new RejectedTaskDelivery('MESSAGE_ID_REUSED');
    if(event.ownerId===INFRASTRUCTURE_OWNER_ID)throw new RejectedTaskDelivery('TASK_NOT_AVAILABLE');
    if(this.production){
      if(event.ownerId===DEVELOPMENT_OWNER_ID) return 'deferred';
      const account=await this.database.client.account.findUnique({where:{ownerId:event.ownerId}});
      if(!account?.enabled)return 'deferred';
    }
    signal.throwIfAborted();return this.identity.run(event.ownerId,()=>this.handler.handle(message,signal));
  }
}

// Reconciliation/publication is an operator command. Its owner comes from private process
// configuration, checked against the account table, never an HTTP header or queue payload.
export async function configuredServiceOwner(database:DatabaseService,env:NodeJS.ProcessEnv):Promise<string>{
  const owner=env.SERVICE_OWNER_ID?ownerIdSchema.parse(env.SERVICE_OWNER_ID):undefined;
  if(owner){
    if(owner===INFRASTRUCTURE_OWNER_ID)return owner;
    if(owner===DEVELOPMENT_OWNER_ID){if(env.APP_ENV==='production')throw new Error('DEVELOPMENT_IDENTITY_FORBIDDEN');return owner;}
    const account=await database.client.account.findUnique({where:{ownerId:owner}});
    if(!account?.enabled)throw new Error('SERVICE_OWNER_NOT_AVAILABLE');return owner;
  }
  if(env.APP_ENV==='development'||env.APP_ENV==='test')return DEVELOPMENT_OWNER_ID;
  throw new Error('SERVICE_OWNER_REQUIRED');
}
