import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class RequestValidationError extends BadRequestException {
  constructor(readonly fields?: { path: string; code: string }[]) { super('Invalid request'); }
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new RequestValidationError(result.error.issues.slice(0, 20).map(issue => ({
      // Never return input values or dynamic record keys; indexes and known schema keys only.
      path: issue.path.map(part => typeof part === 'number' ? String(part) : /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(part)) ? String(part) : 'field').join('.'),
      code: issue.code,
    })));
    return result.data;
  }
}
