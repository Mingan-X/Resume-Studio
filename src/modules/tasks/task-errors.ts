export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;
  constructor() {
    super('该幂等键已用于不同的请求');
    this.name = 'IdempotencyConflictError';
  }
}
