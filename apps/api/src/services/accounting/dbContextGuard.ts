/**
 * The "no DB context across a QuickBooks HTTP call" contract, in one place.
 *
 * `withDbAccessContext` opens ONE real `baseDb.transaction()` and holds it for
 * the whole callback; a nested `withSystemDbAccessContext` JOINS that context
 * (it returns `fn()` directly) and a nested `db.transaction` degrades to a
 * SAVEPOINT. `runOutsideDbContext` only re-routes the AsyncLocalStorage lookup
 * — it cannot commit, or even suspend, a transaction the caller already
 * opened. Two consequences bite this module family specifically:
 *
 *   1. #1105 pool poison — a pooled Postgres connection sits
 *      idle-in-transaction for the entire QuickBooks round trip.
 *   2. Lost sync state — every write the coordinator makes to record a
 *      FAILURE (`sync_status='error'`, the pending mapping row) is rolled back
 *      when the coordinator then throws, because it was only ever a savepoint
 *      inside the caller's transaction. The operator sees no error, and the
 *      retry takes the CREATE path again and double-books the invoice.
 *
 * So every entry point that brackets a QuickBooks call with DB work takes a
 * `DbContextRunner` and asserts, loudly, that it was NOT handed an ambient
 * context. The assert is the enforcement: a caller that forgets and wraps the
 * call in `withAuthDbAccessContext` fails immediately and visibly instead of
 * silently reintroducing either bug.
 */

import { hasDbAccessContext } from '../../db';

/**
 * Opens ONE short DB access context and runs `fn` inside it. Request callers
 * pass `(fn) => withAuthDbAccessContext(auth, fn)`; off-request callers pass
 * `(fn) => withSystemDbAccessContext(fn, '<label>')`. Each invocation is a
 * separate transaction that COMMITS when `fn` resolves, which is what makes
 * the sync-state writes survive a later throw.
 */
export type DbContextRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export function assertNoAmbientDbContext(operation: string): void {
  if (!hasDbAccessContext()) return;
  throw new Error(
    `${operation} must run with NO ambient DB access context: it makes outbound QuickBooks HTTP calls between short `
    + 'transactions. An ambient context pins a pooled connection idle-in-transaction across the whole round trip '
    + '(#1105) AND silently rolls back its sync-state writes (error markers, pending mapping rows) when this call '
    + 'later throws. Close the context first and hand in a runInDbContext runner instead.',
  );
}
