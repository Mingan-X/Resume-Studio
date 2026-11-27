import { setTimeout as delay } from 'node:timers/promises';
import type { JobIndexVector } from '../../src/infrastructure/vector/job-index.vector.js';
import type { IndexCollection } from '../../src/contracts/job-index.js';
import { indexAlias, indexCollectionName } from '../../src/modules/recall/job-chunks.js';

// Exact-run metadata checks complement the container/native-process ownership verifier.
// Unknown creates retain a 15s reconciliation window, including an initially absent collection.
export async function cleanIndexCollections(specs: IndexCollection[], confirmed: Set<string>,
  vector: JobIndexVector, verify: (signal?: AbortSignal) => Promise<void>) {
  await verify();
  const aliases = await vector.listAliases({ signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 });
  for (const alias of aliases) {
    const spec = specs.find(item => indexAlias(item.ownerId) === alias.alias_name && indexCollectionName(item) === alias.collection_name);
    if (spec) await vector.removeAlias(spec, { signal: AbortSignal.timeout(15_000), deadline: Date.now() + 15_000 });
  }
  for (const spec of specs) {
    const name = indexCollectionName(spec), deadline = Date.now() + 15_000;
    let observed = confirmed.has(name), absent = false;
    while (Date.now() < deadline) {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      await verify(signal);
      const exists = await vector.exists(spec, { signal, deadline });
      if (!exists && observed) { absent = true; break; }
      if (exists) { observed = true; await vector.remove(spec, { signal, deadline }); }
      await delay(250);
    }
    if (!observed || !absent) throw new Error('INDEX_COLLECTION_CLEANUP_UNCONFIRMED');
  }
}
