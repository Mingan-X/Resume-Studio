import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { OpenAiModel, openAiModelConfigSchema } from './openai-model.js';
import { ModelExecutor, modelExecutionPolicySchema } from '../../modules/models/model-executor.js';

export async function loadAnalysisModel(rawPath: unknown) {
  const path = z.string().min(1).refine(isAbsolute).parse(rawPath), file = await open(path, 'r');
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > 65536) throw new Error('MODEL_CONFIG_LIMIT');
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > 65536) throw new Error('MODEL_CONFIG_LIMIT');
    const value = z.object({ connection: openAiModelConfigSchema, execution: modelExecutionPolicySchema }).strict()
      .refine(value => value.connection.currency === value.execution.currency).parse(JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown);
    return new ModelExecutor(new OpenAiModel(value.connection), value.execution);
  } finally { await file.close(); }
}
