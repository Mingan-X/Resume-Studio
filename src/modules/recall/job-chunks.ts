import { z } from 'zod';
import { jdDocumentSchema } from '../../contracts/jobs.js';
import { indexedChunkSchema, indexCollectionSchema } from '../../contracts/job-index.js';
import { requestHash } from '../tasks/request-hash.js';
import { textHash } from '../resumes/evidence.js';

function uuid(value: unknown) {
  const hash = requestHash(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function chunkJob(raw: unknown) {
  const document = jdDocumentSchema.parse(raw), text = document.blocks[0]!.text;
  if (text.length > 200_000 || textHash(text) !== document.textHash) throw new Error('JD_HASH_INVALID');
  const result = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1000, text.length);
    // Keep UTF-16 offsets without cutting a supplementary-plane code point in half.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    const part = text.slice(start, end), contentHash = textHash(part);
    result.push(indexedChunkSchema.parse({ chunkId: uuid([document.sourceVersionId, 'jd-chunks-v1', start, end, contentHash]),
      start, end, text: part, contentHash }));
    start = end;
  }
  return result;
}
export function indexPointId(jobVersionId: string, chunkId: string, embeddingVersion: string) {
  return uuid([z.uuid().parse(jobVersionId), z.uuid().parse(chunkId), indexCollectionSchema.shape.embeddingVersion.parse(embeddingVersion)]);
}
export function indexCollectionName(raw: unknown) {
  const spec = indexCollectionSchema.parse(raw), version = spec.embeddingVersion.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  return `rs_jobs_${version}_${spec.dimensions}_${requestHash(spec).slice(0, 32)}`;
}
export function indexAlias(ownerId: string) { return `rs_jobs_${z.uuid().parse(ownerId).replaceAll('-', '_')}_current`; }
export function indexBackfillKey(runId: string, jobVersionId: string) {
  return uuid(['index-backfill-v1', z.uuid().parse(runId), z.uuid().parse(jobVersionId)]);
}
