import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import type { DynamicModule } from '@nestjs/common';
import { SessionIdentity } from './session-identity.js';

export const ownerIdSchema = z.uuid().transform(value => value.toLowerCase());
export const DEVELOPMENT_OWNER_ID = '00000000-0000-4000-8000-000000000001';
export const IDENTITY = Symbol('IDENTITY');

// Trusted application context, never derived from a request body's ownerId.
// HTTP session mode resolves a trusted request context; local mode stays explicit.
export interface IdentityPort {
  getOwnerId(): Promise<string>;
}

@Injectable()
export class DevelopmentIdentity implements IdentityPort {
  getOwnerId(): Promise<string> { return Promise.resolve(DEVELOPMENT_OWNER_ID); }
}

@Module({
  providers: [{ provide: IDENTITY, useClass: DevelopmentIdentity }],
  exports: [IDENTITY],
})
export class IdentityModule {
  static session(): DynamicModule {
    return { module: IdentityModule, providers: [{ provide: IDENTITY, useClass: SessionIdentity }], exports: [IDENTITY] };
  }
}
