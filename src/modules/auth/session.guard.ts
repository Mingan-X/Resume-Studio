import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { AuthRepository } from '../../infrastructure/tasks/auth.repository.js';
import { AuthController } from './auth.controller.js';
import { HealthController } from '../health/health.controller.js';
import { AUTH_CONFIG } from './auth-config.js';
import type { AuthConfig } from './auth-config.js';
import { readSessionCookie, requireCsrf } from './session-token.js';
import { authenticatedOwner } from '../identity/session-identity.js';
import type { AuthenticatedRequest } from '../identity/session-identity.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: AuthRepository, @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getClass() === AuthController || context.getClass() === HealthController) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(request.headers.cookie);
    const session = token ? await this.sessions.session(token) : null;
    if (!session?.account) throw new UnauthorizedException();
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      requireCsrf(session.token, request.headers['x-csrf-token'], request.headers.origin, this.config.origin);
    }
    request[authenticatedOwner] = session.account.ownerId;
    return true;
  }
}
