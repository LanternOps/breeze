import type { db } from '../../db';

/**
 * The subset of the drizzle handle every backup-provider sync service needs.
 *
 * Callers pass the ambient `db` proxy from inside a
 * `withSystemDbAccessContext(...)`: under an open context that proxy IS the
 * transaction (apps/api/src/db/index.ts:525-575), so "pass the tx" and "pass
 * db" are the same object. Typing it as a `Pick` — the shape
 * services/softwareInventoryObservations.ts:231 uses — documents which
 * operations the callee performs and keeps the unit tests' hand-rolled stubs
 * small.
 */
export type ProviderSyncTx = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'
>;
