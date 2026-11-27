import { setTimeout as delay } from 'node:timers/promises';
import type { JobIndexVector } from '../../src/infrastructure/vector/job-index.vector.js';
import type { IndexCollection } from '../../src/contracts/job-index.js';
import { indexAlias, indexCollectionName } from '../../src/modules/recall/job-chunks.js';
import { isRetryable, TaskFailure } from '../../src/infrastructure/consumer/failure.js';

// Exact-run metadata checks complement the container/native-process ownership verifier.
// Unknown creates retain a 15s reconciliation window, including an initially absent collection.
export async function cleanIndexCollections(specs: IndexCollection[], confirmed: Set<string>,
  vector: Pick<JobIndexVector, 'listAliases' | 'exists' | 'removeAlias' | 'remove'>, verify: (signal?: AbortSignal) => Promise<void>, budgetMs = 15_000) {
  if (!Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > 15_000) throw new Error('INDEX_CLEANUP_BUDGET_INVALID');
  await verify();
  for (const spec of specs) {
    const name = indexCollectionName(spec), deadline = Date.now() + budgetMs;
    let observed = confirmed.has(name), absent = false;
    while (Date.now() < deadline) {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      await verify(signal);
      try {
        const exists = await vector.exists(spec, { signal, deadline });
        if (!exists && observed) { absent = true; break; }
        if (exists) {
          observed = true;
          const aliases = await vector.listAliases({ signal, deadline });
          if (aliases.some(alias => alias.alias_name === indexAlias(spec.ownerId) && alias.collection_name === name)) await vector.removeAlias(spec, { signal, deadline });
          await vector.remove(spec, { signal, deadline });
        }
      } catch (error) {
        // A dropped read/delete response is not proof of absence; use the remaining original window.
        if (signal.aborted || Date.now() >= deadline) break;
        if (!(error instanceof TaskFailure) || !isRetryable(error.code)) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(250, remaining));
    }
    if (!observed || !absent) throw new Error('INDEX_COLLECTION_CLEANUP_UNCONFIRMED');
  }
}
