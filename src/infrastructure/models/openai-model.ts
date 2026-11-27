import { readFile, stat } from 'node:fs/promises';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { versionNameSchema } from '../../contracts/jobs.js';
import { ModelFailure } from '../../modules/models/model.port.js';
import type { ModelPort, ModelResponse } from '../../modules/models/model.port.js';
import { redactContactText } from '../../modules/models/privacy.js';

export const openAiModelConfigSchema = z.object({
  baseURL: z.url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  }),
  apiKey: z.string().min(1).max(1024), model: z.string().min(1).max(128), modelConfigVersion: versionNameSchema,
  timeoutMs: z.int().positive().max(120000), maxResponseBytes: z.int().min(1024).max(4 * 1024 * 1024).default(1024 * 1024),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
export type OpenAiModelConfig = z.infer<typeof openAiModelConfigSchema>;

export async function loadOpenAiModel(path: string): Promise<OpenAiModel> {
  try {
    const info = await stat(path); if (!info.isFile() || info.size > 16384) throw new Error();
    return new OpenAiModel(openAiModelConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown));
  } catch { throw new Error('MODEL_CONFIG_INVALID'); }
}

export class OpenAiModel implements ModelPort {
  readonly modelConfigVersion: string;
  private readonly config: OpenAiModelConfig;
  constructor(input: unknown) {
    const result = openAiModelConfigSchema.safeParse(input);
    if (!result.success) throw new Error('MODEL_CONFIG_INVALID');
    this.config = result.data; this.modelConfigVersion = result.data.modelConfigVersion;
  }
  async invoke(request: Parameters<ModelPort['invoke']>[0], signal: AbortSignal): Promise<ModelResponse> {
    // Reject ambient SDK logging/tracing opt-ins; business observation uses the project's sanitized spans.
    if (['LANGSMITH_TRACING', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_VERBOSE'].some(key => /^(true|1)$/i.test(process.env[key] ?? ''))
      || /^(debug|info)$/i.test(process.env.OPENAI_LOG ?? '')) throw new ModelFailure('UNAVAILABLE');
    if (signal.aborted) throw new ModelFailure('CANCELLED');
    const c = this.config, timeout = AbortSignal.timeout(c.timeoutMs), combined = AbortSignal.any([signal, timeout]);
    const messages = request.messages.map(message => {
      if (typeof message.content !== 'string') throw new ModelFailure('OUTPUT_INVALID');
      // JD service already masks labeled lines before JSON encoding. Do not mask JSON delimiters or evidence UUIDs.
      const content = redactContactText(message.content, false);
      if (message.getType() === 'system') return new SystemMessage(content);
      if (message.getType() === 'human') return new HumanMessage(content);
      if (message.getType() === 'ai') return new AIMessage(content);
      throw new ModelFailure('OUTPUT_INVALID');
    });
    let wireFailure: ModelFailure | undefined;
    const safeFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, { ...init, signal: combined, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        wireFailure = new ModelFailure(response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UPSTREAM_5XX'
          : [400, 404, 422].includes(response.status) ? 'UNSUPPORTED_MODEL' : 'UNAVAILABLE');
        throw wireFailure;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ModelFailure('OUTPUT_INVALID');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length;
          if (size > c.maxResponseBytes) { wireFailure = new ModelFailure('OUTPUT_INVALID'); throw wireFailure; }
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'content-type': 'application/json' } });
    };
    try {
      const model = new ChatOpenAI({ apiKey: c.apiKey, model: c.model, maxRetries: 0, timeout: c.timeoutMs,
        maxTokens: request.maxOutputTokens, streaming: false, useResponsesApi: false,
        configuration: { baseURL: c.baseURL, maxRetries: 0, fetch: safeFetch },
      });
      const raw = await model.invoke(messages, { signal: combined, callbacks: [],
        response_format: { type: 'json_schema', json_schema: { name: 'validated_output', strict: true, schema: z.toJSONSchema(request.schema) } },
      });
      if (combined.aborted) throw new ModelFailure(signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      if (typeof raw.content !== 'string' || raw.tool_calls?.length || raw.invalid_tool_calls?.length
        || raw.additional_kwargs.refusal) throw new ModelFailure('OUTPUT_INVALID');
      const output = request.schema.parse(JSON.parse(raw.content) as unknown);
      const usage = z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() }).safeParse(raw.usage_metadata);
      return { output, usage: usage.success ? { inputTokens: usage.data.input_tokens, outputTokens: usage.data.output_tokens,
        costMicros: null, currency: c.currency } : null };
    } catch (error) {
      if (signal.aborted) throw new ModelFailure('CANCELLED');
      if (timeout.aborted) throw new ModelFailure('TIMEOUT');
      if (wireFailure) throw wireFailure;
      if (error instanceof ModelFailure) throw error;
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new ModelFailure('OUTPUT_INVALID');
      // Do not expose third-party messages, response bodies, headers or credentials.
      throw new ModelFailure('UNAVAILABLE');
    }
  }
}
