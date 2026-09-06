import { withDbAccessContext, runOutsideDbContext, type DbAccessContext } from '../db';

export interface BulkResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  skippedReasons: Record<string, number>;
}

const SKIP_STATUSES = new Set([400, 403, 404, 409]);

function asServiceError(err: unknown): { status: number; code?: string; message?: string } | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return err as { status: number; code?: string; message?: string };
  }
  return null;
}

/**
 * Run a per-item async operation over a list of ids, isolating per-item failures.
 * Expected 4xx service errors (not-a-draft, org-denied, not-found, invalid-state)
 * count as `skipped` (tallied by `.code`); anything else counts as `failed`.
 */
export async function runBulk<T>(
  ids: string[],
  perItem: (id: string) => Promise<T>
): Promise<BulkResult> {
  const result: BulkResult = { total: ids.length, succeeded: 0, skipped: 0, failed: 0, skippedReasons: {} };
  for (const id of ids) {
    try {
      await perItem(id);
      result.succeeded++;
    } catch (err) {
      const svc = asServiceError(err);
      if (svc && SKIP_STATUSES.has(svc.status)) {
        result.skipped++;
        const code = svc.code ?? 'OTHER';
        result.skippedReasons[code] = (result.skippedReasons[code] ?? 0) + 1;
      } else {
        result.failed++;
        console.error('[runBulk] item failed:', id, err instanceof Error ? err.message : err);
      }
    }
  }
  return result;
}

/**
 * Like {@link runBulk}, but runs EACH item in its own short RLS transaction
 * instead of the caller's ambient request transaction.
 *
 * Why this matters (do not collapse back into a plain `runBulk` on the
 * request transaction):
 *  - **Correct partial-success counts.** On the shared request transaction a
 *    Postgres-level error (FK/trigger) aborts the whole transaction, so every
 *    "succeeded" item silently rolls back at commit while still being counted.
 *    Per-item transactions make each success durable independent of siblings.
 *  - **Connection-pool safety (#1105).** The bulk loop can do slow per-item
 *    work (a quote/invoice email send, a sub-transaction in issue/void). On
 *    one held request transaction that pins a single pooled connection
 *    idle-in-transaction for the whole batch; per-item transactions release
 *    the connection between items.
 *
 * `runOutsideDbContext` exits the ambient request context so each
 * `withDbAccessContext(ctx, …)` opens a fresh transaction; `ctx` re-establishes
 * the caller's exact RLS scope (build it with `dbAccessContextFromAuth`) so
 * tenant isolation is identical to the request path.
 *
 * `afterItemCommit` (#3905) runs for each item AFTER its own transaction has
 * committed and BEFORE the next item starts — the seam for post-commit work
 * that must not be done under the item's locks, such as the deferred quote
 * email (`services/quoteLifecycle.ts`, DeferredQuoteEmail). It is inside the
 * same per-item try/catch as `perItem`, so a throw from it counts the item the
 * way any other item failure counts; a best-effort hook should swallow its own
 * errors rather than turn a committed item into a reported failure.
 */
export async function runBulkIsolated<T>(
  ctx: DbAccessContext,
  ids: string[],
  perItem: (id: string) => Promise<T>,
  afterItemCommit?: (id: string, value: T) => Promise<void>
): Promise<BulkResult> {
  return runOutsideDbContext(() =>
    runBulk(ids, async (id) => {
      const value = await withDbAccessContext(ctx, () => perItem(id));
      if (afterItemCommit) await afterItemCommit(id, value);
      return value;
    })
  );
}
