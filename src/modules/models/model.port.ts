import type { BaseMessage } from '@langchain/core/messages';
import type { z } from 'zod';
import type { ModelResponse } from '../../contracts/model.js';
export { modelUsageSchema, modelResponseSchema } from '../../contracts/model.js';
export type { ModelResponse, ModelUsage } from '../../contracts/model.js';
export interface ModelPort {
  readonly modelConfigVersion: string;
  invoke(request: { messages: BaseMessage[]; schema: z.ZodType; maxOutputTokens: number }, signal: AbortSignal): Promise<ModelResponse>;
}
export const modelFailureCodes = ['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_5XX', 'UNAVAILABLE', 'UNSUPPORTED_MODEL',
  'OUTPUT_INVALID', 'BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED', 'CANCELLED', 'BUSY', 'UNSETTLED'] as const;
export class ModelFailure extends Error {
  constructor(readonly code: typeof modelFailureCodes[number]) { super(code); }
}
