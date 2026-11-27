import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { analysisConfigurationSchema } from '../../contracts/tasks.js';
import { ConfigValidationError } from '../../modules/config/app-config.js';

export async function loadAnalysisConfiguration(path: string | undefined) {
  if (!path) return null;
  try {
    if (!isAbsolute(path)) throw new Error();
    const file = await open(path, 'r');
    let content: unknown;
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > 65_536) throw new Error();
      const buffer = Buffer.alloc(65_537); let size = 0;
      while (size < buffer.length) {
        const result = await file.read(buffer, size, buffer.length - size, null);
        if (result.bytesRead === 0) break; size += result.bytesRead;
      }
      if (size > 65_536) throw new Error();
      content = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } finally { await file.close(); }
    const value = analysisConfigurationSchema.parse(content);
    if (value.indexTarget.provenance !== 'bailian') throw new Error();
    return value;
  } catch { throw new ConfigValidationError(['ANALYSIS_CONFIG_FILE']); }
}
