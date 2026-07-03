/**
 * Savepoint error-isolation regression test (issue #2189, spike).
 *
 * QUESTION: inside the withDbAccessContext request transaction (postgres.js
 * `sql.begin`), does wrapping a statement that is EXPECTED to fail in a nested
 * Drizzle transaction (`db.transaction` → postgres.js `sql.savepoint`) isolate
 * the error so that (a) the outer transaction stays healthy (no 25P02 on
 * follow-up queries) and (b) the outer begin() does NOT re-throw the handled
 * error when the callback resolves?
 *
 * SOURCE ANALYSIS (postgres@3.4.9, src/index.js):
 *   - begin() → scope(connection, fn) [~line 251]. EACH scope() call creates
 *     its own `Sql(handler)` instance with a CLOSURE-SCOPED `uncaughtError`,
 *     and its handler records errors only for queries issued through that
 *     scope's sql instance: `q.catch(e => uncaughtError || (uncaughtError = e))`
 *     [~292].
 *   - `sql.savepoint(fn)` → scope(c, fn, 's<N>') [~283-288]: emits
 *     `savepoint sN`, and on error runs `rollback to sN` [~266-271] — restoring
 *     the OUTER transaction to health — then rethrows to the caller. The outer
 *     scope's `uncaughtError` stays unset, so the outer commit path
 *     (`if (uncaughtError) throw uncaughtError`) stays clean.
 *   - drizzle-orm@0.45.2 postgres-js/session.js [~130-131]: a nested
 *     `transaction()` on a PostgresJsTransaction calls
 *     `this.session.client.savepoint(...)` — exactly the API above.
 *
 * CRITICAL USAGE CAVEAT: the failing statement MUST be issued on the nested
 * callback's `tx` object. The ambient `db` proxy still resolves (via
 * AsyncLocalStorage) to the OUTER transaction's sql instance, whose handler
 * would record the error in the OUTER scope — reintroducing the clobber.
 *
 * The CONTROL test documents the bug mechanism itself: without the savepoint,
 * a caught-and-handled unique violation aborts the transaction (follow-up
 * queries fail with 25P02) and the raw error is re-thrown at commit even
 * though the callback resolved.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { catalogItems } from '../../db/schema';
import { createPartner } from './db-utils';
import { isPgUniqueViolation, pgErrorCode } from '../../utils/pgErrors';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [partnerId], userId: null };
}

// Minimal catalog row; catalog_items_partner_sku_uq (partner_id, sku) is the
// unique index we deliberately violate.
const item = (partnerId: string, name: string, sku: string) => ({
  partnerId,
  itemType: 'service' as const,
  name,
  sku,
  unitPrice: '1.00',
});

describe('postgres.js savepoint error isolation (real DB, breeze_app)', () => {
  runDb('a unique violation inside a nested db.transaction (SAVEPOINT) does not poison the outer request transaction', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const SKU = 'SAVEPOINT-SPIKE-1';

    const outcome = await withDbAccessContext(partnerCtx(partner.id), async () => {
      await db.insert(catalogItems).values(item(partner.id, 'first', SKU));

      let caught: unknown;
      try {
        // Nested Drizzle transaction → postgres.js sql.savepoint → its OWN
        // scope with its own uncaughtError. The duplicate insert MUST go
        // through `tx` (see file header caveat).
        await db.transaction(async (tx) => {
          await tx.insert(catalogItems).values(item(partner.id, 'dup', SKU));
        });
      } catch (err) {
        caught = err;
      }

      // (a) The savepoint rollback restored the outer transaction: this
      // follow-up query would fail with 25P02 if the abort had escaped.
      const rows = await db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(and(eq(catalogItems.partnerId, partner.id), eq(catalogItems.sku, SKU)));
      return { caught, rowCount: rows.length };
    });

    // (b) Reaching here at all proves the outer begin() resolved instead of
    // re-throwing the inner error at commit (each scope tracks its own
    // uncaughtError).
    expect(isPgUniqueViolation(outcome.caught)).toBe(true);
    expect(outcome.rowCount).toBe(1);

    // And the outer transaction genuinely COMMITTED (not rolled back): the
    // first insert is visible from a fresh context.
    const persisted = await withSystemDbAccessContext(() =>
      db.select({ id: catalogItems.id }).from(catalogItems)
        .where(and(eq(catalogItems.partnerId, partner.id), eq(catalogItems.sku, SKU)))
    );
    expect(persisted).toHaveLength(1);
  });

  runDb('CONTROL (bug mechanism, #2189): without a savepoint the handled violation aborts the transaction and is re-thrown at commit', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const SKU = 'SAVEPOINT-SPIKE-CONTROL';

    let followUpError: unknown;
    await expect(
      withDbAccessContext(partnerCtx(partner.id), async () => {
        await db.insert(catalogItems).values(item(partner.id, 'first', SKU));

        // "Handle" the violation the way the pre-#2189 call sites did…
        try {
          await db.insert(catalogItems).values(item(partner.id, 'dup', SKU));
        } catch {
          // mapped to a friendly 4xx and swallowed — callback will RESOLVE
        }

        // …but the transaction is already aborted: any follow-up statement
        // fails with 25P02.
        try {
          await db.select({ id: catalogItems.id }).from(catalogItems)
            .where(eq(catalogItems.partnerId, partner.id));
        } catch (err) {
          followUpError = err;
        }
        return 'resolved';
      })
      // …and postgres.js re-throws the ORIGINAL raw error at commit even
      // though the callback resolved — this is what clobbered mapped 409s
      // into raw 500s.
    ).rejects.toSatisfy((err: unknown) => isPgUniqueViolation(err));

    expect(pgErrorCode(followUpError)).toBe('25P02');
  });
});
