/**
 * Real-DB proof that runBulkIsolated runs EACH item in its own transaction.
 *
 * The bulk billing endpoints rely on per-item isolation for two guarantees the
 * unit tests can only assert at the wiring level (they stub `../db`):
 *   1. A per-item failure must NOT roll back siblings that already succeeded —
 *      and the returned counts must reflect what actually persisted.
 *   2. Each item commits independently (no single held request transaction).
 *
 * This exercises the REAL `withDbAccessContext` + `runOutsideDbContext`
 * (AsyncLocalStorage exit + a fresh `breeze_app` transaction per item) against
 * Postgres, using `quotes` (org-axis RLS) as the tenant table. If runBulkIsolated
 * regressed to looping on one shared transaction, the post-write throw on item 2
 * would abort the whole transaction and item 1's delete would roll back too —
 * making the "item 1 is gone" assertion fail.
 *
 * Fixture re-seeded per test (integration/setup.ts TRUNCATEs CASCADE in
 * beforeEach); matches every sibling *.integration.test.ts. No memoization.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { quotes } from '../../db/schema/quotes';
import { createOrganization, createPartner } from './db-utils';
import { createQuote, deleteDraftQuote } from '../../services/quoteService';
import { runBulkIsolated } from '../../lib/bulkOps';
import { type QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  orgA: { id: string };
  actorA: QuoteActor;
  ctxA: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const actorA: QuoteActor = { userId: null, partnerId: partnerA.id, accessibleOrgIds: null };
    // quotes use org-axis RLS, so the context must list orgA on the accessible
    // org axis — exactly what dbAccessContextFromAuth would produce for a
    // partner admin (mirrors the request middleware).
    const ctxA: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };
    return { orgA: { id: orgA.id }, actorA, ctxA };
  });
}

async function seedDraft(fx: Fixture): Promise<string> {
  const q = await withDbAccessContext(fx.ctxA, () =>
    createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
  );
  return q.id;
}

/** Count surviving quote rows by id, read under system scope (bypasses RLS). */
async function exists(id: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, id));
    return rows.length > 0;
  });
}

describe('runBulkIsolated per-item transaction isolation (breeze_app, real DB)', () => {
  runDb('a post-write throw on one item rolls back only that item; siblings persist', async () => {
    const fx = await seedFixture();
    const id1 = await seedDraft(fx);
    const id2 = await seedDraft(fx);

    // perItem deletes the row, then throws for id2 AFTER the write. With per-item
    // transactions, id2's delete rolls back (row survives) while id1 commits.
    const result = await runBulkIsolated(fx.ctxA, [id1, id2], async (id) => {
      await db.delete(quotes).where(eq(quotes.id, id));
      if (id === id2) throw new Error('simulated post-write failure');
    });

    expect(result).toMatchObject({ total: 2, succeeded: 1, skipped: 0, failed: 1 });
    expect(await exists(id1)).toBe(false); // committed independently
    expect(await exists(id2)).toBe(true); // its transaction rolled back
  });

  runDb('deletes every draft via the real service when all items succeed', async () => {
    const fx = await seedFixture();
    const id1 = await seedDraft(fx);
    const id2 = await seedDraft(fx);

    const result = await runBulkIsolated(fx.ctxA, [id1, id2], (id) =>
      deleteDraftQuote(id, fx.actorA)
    );

    expect(result).toMatchObject({ total: 2, succeeded: 2, skipped: 0, failed: 0 });
    expect(await exists(id1)).toBe(false);
    expect(await exists(id2)).toBe(false);
  });
});
