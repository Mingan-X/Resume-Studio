import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';

export const ownerIdSchema = z.uuid().transform(value => value.toLowerCase());
export const DEVELOPMENT_OWNER_ID = '00000000-0000-4000-8000-000000000001';
export const IDENTITY = Symbol('IDENTITY');

// Trusted application context, never derived from a request body's ownerId.
// A future authentication adapter can replace this provider without changing task creation.
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
export class IdentityModule {}
