import { Inject, Injectable, Scope, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { IdentityPort } from './identity.module.js';

// Assigned only after a server-side session lookup, never copied from HTTP fields.
export const authenticatedOwner = Symbol('authenticatedOwner');
export type AuthenticatedRequest = IncomingMessage & { [authenticatedOwner]?: string };
@Injectable({ scope: Scope.REQUEST })
export class SessionIdentity implements IdentityPort {
  constructor(@Inject(REQUEST) private readonly request: AuthenticatedRequest) {}
  getOwnerId(): Promise<string> {
    const owner = this.request[authenticatedOwner];
    if (!owner) throw new UnauthorizedException();
    return Promise.resolve(owner);
  }
}
