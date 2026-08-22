import './setup';
import { describe, it, expect, vi } from 'vitest';

// Catalog events are a fire-and-forget BullMQ side effect, not the correctness
// under test. Mocked so these races don't open a BullMQ socket to test Redis
// (same rationale as invoiceIssueRace.integration.test.ts).
vi.mock('../../services/catalogEvents', () => ({ emitCatalogEvent: vi.fn().mockResolvedValue(undefined) }));

import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, catalogItems } from '../../db/schema';
import * as svc from '../../services/catalogService';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;

/**
 * #3816 — `setBundleComponents` validated bundle/component flags with unlocked
 * reads and replaced the component set OUTSIDE a transaction, so a concurrent
 * `updateCatalogItem` could convert a component into a bundle after it had been
 * observed as a plain item, producing a NESTED BUNDLE.
 *
 * The fix locks the deduplicated, globally SORTED union of
 * {bundleId, ...componentIds} as `catalog_items` rows, revalidates under those
 * locks, and does the replace in one transaction. Locking the ITEM rows rather
 * than the `catalog_bundle_components` edge rows is the load-bearing choice:
 * `updateCatalogItem`'s guard searches for the ABSENCE of an edge, and
 * `FOR UPDATE` cannot lock a row that does not exist yet. It works because the
 * component item must already exist (FK), so both writers contend on that row.
 *
 * HONEST LIMIT OF THIS TEST — read before trusting it as proof. It is a
 * REGRESSION GUARD, not a reproduction of the original bug. It asserts the
 * invariant under real contention; it does NOT reliably fail against the
 * unfixed service.
 *
 * That was measured, not assumed. Three designs were tried against the
 * pre-fix code:
 *   - A single race asserting "no nested bundle afterwards": passed unfixed.
 *   - A holder client pre-locking the component row, asserting BOTH backends
 *     block: passed unfixed too. The INSERT's own foreign-key check takes a
 *     lock on that row, so the unfixed path blocks as well, just later — "both
 *     blocked" says nothing about whether validation happened under the lock.
 *   - Repeated unsynchronised trials: failed once on an early attempt, then
 *     passed 3/3 at 12 trials and 3/3 at 60. The scheduler here consistently
 *     favours one ordering, so repetition does not force the interleaving.
 *
 * Reproducing it deterministically needs barriers that pin the unfixed
 * sequence (validate unlocked -> conversion commits -> insert), which means a
 * test-only seam in the service. That was judged out of scope for a lock fix;
 * see the PR discussion.
 */

interface Fixture { partnerId: string; bundleA: string; bundleB: string; plain: string }

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Bundle race ${suffix}`, slug: `bundle-race-${suffix}`,
      type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const mk = async (name: string, isBundle: boolean) => {
      const [row] = await db.insert(catalogItems).values({
        partnerId, name: `${name}-${suffix}`, sku: `${name}-${suffix}`,
        itemType: 'service', billingType: 'one_time', isBundle, isActive: true,
        // Both still NOT NULL: unit_price is the deprecated partner-currency
        // mirror #3812 wants to drop; cost_currency arrived with wave 3.
        unitPrice: '10.00', costCurrency: 'USD'
      }).returning({ id: catalogItems.id });
      return row!.id;
    };
    return {
      partnerId,
      bundleA: await mk('bundle-a', true),
      bundleB: await mk('bundle-b', true),
      plain: await mk('plain', false),
    };
  });
}

function actorFor(partnerId: string) {
  return { partnerId, userId: null } as unknown as Parameters<typeof svc.setBundleComponents>[2];
}

/**
 * The service runs under RLS. Without a tenant context every catalog read is
 * filtered away and the calls fail ITEM_NOT_FOUND — which made the invariant
 * assertions pass VACUOUSLY in an earlier revision of this file.
 */
function ctx(partnerId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null };
}

/**
 * Scoped to the fixture's partner, deliberately. Counting nested edges across
 * the whole integration database would let unrelated seeded rows — or another
 * test's data — fail this assertion even when the race under test stayed safe.
 */
async function nestedBundleCount(partnerId: string): Promise<number> {
  const rows = await getTestDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM catalog_bundle_components c
    JOIN catalog_items i ON i.id = c.component_item_id
    WHERE i.is_bundle = true AND c.partner_id = ${partnerId}
  `);
  return rows[0]?.n ?? 0;
}

describe.runIf(RUN)('#3816 catalog bundle composition races', () => {
  it('repeated convert-vs-compose races never produce a nested bundle', async () => {
    // Repeated rather than single-shot so the assertion sees more than one
    // scheduling outcome. See the file header for the measured limit: this does
    // NOT reliably fail against the unfixed service, so treat a pass as "the
    // invariant held under contention", not as proof the race is closed.
    const TRIALS = 12;
    for (let i = 0; i < TRIALS; i++) {
      const f = await seedFixture();
      const results = await Promise.allSettled([
        withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
          f.bundleA,
          [{ componentItemId: f.plain, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
          actorFor(f.partnerId)
        )),
        withDbAccessContext(ctx(f.partnerId), () =>
          svc.updateCatalogItem(f.plain, { isBundle: true }, actorFor(f.partnerId))),
      ]);

      // The invariant, asserted per trial against the database rather than the
      // return values, so a silent success cannot hide.
      expect(await nestedBundleCount(f.partnerId), `nested bundle created on trial ${i}`).toBe(0);
      // And at least one writer must have been refused — both winning IS the bug.
      expect(results.some((r) => r.status === 'rejected'), `both writers succeeded on trial ${i}`).toBe(true);
    }
  });

  it('crossed parent/component requests reject as BUNDLE_NESTED rather than deadlocking', async () => {
    // Regression guard for the lock ORDER, not for the original bug (the
    // unfixed code takes no locks and so cannot deadlock). Parent-first then
    // components-ascending — the order the issue prescribes — has set(A,[B])
    // hold A and want B while set(B,[A]) holds B and wants A: a cycle that
    // forms BEFORE validation can reject either, turning two clean 400s into a
    // 40P01. Locking the sorted UNION puts both callers on one global order.
    const f = await seedFixture();

    const results = await Promise.allSettled([
      withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
        f.bundleA, [{ componentItemId: f.bundleB, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
        actorFor(f.partnerId))),
      withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
        f.bundleB, [{ componentItemId: f.bundleA, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
        actorFor(f.partnerId))),
    ]);

    for (const r of results) {
      expect(r.status).toBe('rejected');
      const err = (r as PromiseRejectedResult).reason as { code?: string };
      // Specifically the domain error — never a serialization failure.
      expect(err?.code).toBe('BUNDLE_NESTED');
    }
    expect(await nestedBundleCount(f.partnerId)).toBe(0);
  });
});
