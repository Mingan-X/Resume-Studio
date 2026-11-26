import type { Prisma } from '../../generated/prisma/client.js';

// Execution stores need interactive transactions only, not the entire client or connection pool.
export interface TransactionDatabase {
  client: { $transaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };
}
