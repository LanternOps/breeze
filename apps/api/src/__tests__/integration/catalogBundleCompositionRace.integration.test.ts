import './setup';
import { describe, it, expect, vi } from 'vitest';

// Catalog events are a fire-and-forget BullMQ side effect, not the correctness
// under test. Mocked so these races don't open a BullMQ socket to test Redis
// (same rationale as invoiceIssueRace.integration.test.ts).
vi.mock('../../services/catalogEvents', () => ({ emitCatalogEvent: vi.fn().mockResolvedValue(undefined) }));

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { pgErrorCode } from '../../utils/pgErrors';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, catalogItems } from '../../db/schema';
import * as svc from '../../services/catalogService';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;

/**
 * #3816 — `setBundleComponents` validated bundle/component flags with UNLOCKED
 * reads, so a concurrent `updateCatalogItem` could convert a component into a
 * bundle after it had been observed as a plain item, producing a NESTED BUNDLE.
 *
 * The unlocked reads are the whole bug. An earlier draft of this header also
 * said the replace happened "outside a transaction" — that was FALSE and is
 * corrected here: on the REST path, the AI-tool path and in these tests, the old
 * delete and insert both ran inside the outer `withDbAccessContext`
 * transaction. The service-local transaction the fix adds is a SAVEPOINT there,
 * and its value is scoping the row locks, not adding atomicity.
 *
 * The fix locks, in one globally SORTED order, the deduplicated set of
 * {bundleId, ...componentIds} that THIS PARTNER OWNS, revalidates under those
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
  /**
   * The id normaliser must accept EXACTLY the language Postgres accepts, and
   * canonicalise to exactly what Postgres renders. Being MORE permissive is the
   * dangerous direction: it turns a string the server refuses into a valid id
   * addressing a real row.
   *
   * The oracle is `pg_input_is_valid(v,'uuid')`, NOT a try/catch around a cast.
   * A catch-all would report "Postgres rejected it" for a connection drop, a
   * protocol error or a 25P02 aborted transaction, so a negative case could pass
   * without the uuid parser ever running. `pg_input_is_valid` returns the
   * parser's own verdict and still lets unrelated failures throw.
   *
   * Coverage is exhaustive over the hyphen grammar rather than a hand-picked
   * table: a uuid is 8 groups of 4 hex digits with an optional hyphen after each
   * of the first 7, so ALL 2^7 = 128 masks are generated, each in braced and
   * unbraced form.
   */
  it('normalises exactly the uuid spellings Postgres accepts, and no others', async () => {
    const ID = '550e8400-e29b-41d4-a716-446655440000';
    const HEX = ID.replace(/-/g, '');
    const db_ = getTestDb();
    const pgAccepts = async (v: string) => {
      const rows = await db_.execute<{ accepted: boolean }>(
        sql`select pg_input_is_valid(${v}, 'uuid') as accepted`
      );
      return rows[0]!.accepted;
    };

    const groups = HEX.match(/.{4}/g)!;
    const spellings: string[] = [];
    for (let mask = 0; mask < 128; mask++) {
      const body = groups
        .map((g, i) => (i < 7 && (mask >> i) & 1 ? `${g}-` : g))
        .join('');
      spellings.push(body, `{${body}}`, body.toUpperCase(), `{${body.toUpperCase()}}`);
    }
    // Spellings Postgres refuses. Kept alongside the positives and asserted
    // through the SAME oracle, so the test proves agreement in both directions.
    spellings.push(
      `{${ID}`, `${ID}}`, `{${ID}`.toUpperCase(), ` ${ID}`, `${ID} `, `${ID}\n`, `${ID}\t`,
      '5-50e8400-e29b-41d4-a716-446655440000',
      '550e8400--e29b-41d4-a716-446655440000',
      `-${HEX}`, `${HEX}-`, '{}', '{-}', 'not-a-uuid', '',
      HEX.slice(0, 31), `${HEX}0`, HEX.replace('5', 'g'),
      `550e8400-e29b-41d4-a716-44665544000${String.fromCharCode(0x0430)}`,
    );

    let accepts = 0;
    for (const v of spellings) {
      const accepted = await pgAccepts(v);
      if (accepted) accepts++;
      const out = svc.__testables.canonicalUuid(v);
      expect(out, accepted
        ? `Postgres ACCEPTS ${JSON.stringify(v)} — the normaliser must render it canonically`
        : `Postgres REJECTS ${JSON.stringify(v)} — the normaliser must NOT invent a valid id from it`
      ).toBe(accepted ? ID : v);
    }
    // Guard the oracle itself: if pg_input_is_valid ever returned false for
    // everything, every assertion above would collapse into the trivial
    // "unchanged" branch and the test would pass while proving nothing.
    expect(accepts, 'the positive half of the table must actually be accepted').toBe(512);

    // An embedded NUL is asserted OUTSIDE the oracle loop on purpose: Postgres's
    // wire protocol cannot carry one in a text parameter, so pg_input_is_valid
    // raises 22021 rather than answering. That is the new oracle behaving
    // correctly — the old try/catch would have swallowed it and scored this as
    // "Postgres rejected it", proving nothing. The helper must still leave it
    // alone so the id fails downstream exactly as any other malformed id would.
    expect(svc.__testables.canonicalUuid(`${ID}\u0000`)).toBe(`${ID}\u0000`);
  });

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

      // EXACTLY one writer wins, not merely "at least one was refused". Both
      // orderings leave one fulfilled and one rejected: if composition commits
      // first, the conversion then sees the edge and refuses; if the conversion
      // commits first, composition sees is_bundle=true under its own lock and
      // raises BUNDLE_NESTED. So a trial where BOTH reject is a real failure —
      // it means something rejected for an unrelated reason and the weaker
      // `.some(rejected)` assertion this replaces would have passed it.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length, `expected exactly one winner on trial ${i}, got ${results.map((r) => r.status).join('/')}`).toBe(1);
      expect(rejected.length, `expected exactly one refusal on trial ${i}`).toBe(1);
      // BUNDLE_NESTED either way, which is why one code covers both orderings:
      // setBundleComponents raises it at 400 when it finds is_bundle=true under
      // its lock, and updateCatalogItem raises it at 409 when it finds the edge.
      // Asserting the CODE is what makes this a nesting test — without it a
      // refusal for any other reason would satisfy the count.
      const code = (rejected[0] as PromiseRejectedResult).reason?.code;
      expect(code, `unexpected refusal code on trial ${i}`).toBe('BUNDLE_NESTED');
    }
  });

  /**
   * Postgres accepts UPPER case, `{braces}` and hyphen-less uuids, and renders
   * all of them canonically. Every JS-side check here (the locked Map, the
   * duplicate `seen` Set, the self-reference `===`) is exact-string. Locking is
   * what made that reachable: the parent used to be resolved by a SQL `eq` that
   * compared 128 bits and never saw the spelling, and is now a Map lookup that
   * does — so without normalisation a non-canonical parent 404s a row that was
   * found AND LOCKED one statement earlier.
   *
   * The ids here are HARD-CODED and contain a-f deliberately. With
   * `defaultRandom()` ids there is a small chance of an all-numeric uuid, for
   * which `.toUpperCase()` is a no-op and the control would pass against the
   * unfixed code for the wrong reason.
   */
  it('accepts upper-case, braced and hyphen-less UUIDs, and still catches a duplicate across spellings', async () => {
    const f = await seedFixture();
    // Every one of these contains a-f, so upper-casing is never a no-op.
    const BUNDLE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const COMP = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const OTHER = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    await withSystemDbAccessContext(async () => {
      for (const [id, name, isBundle] of [[BUNDLE, 'case-bundle', true], [COMP, 'case-comp', false], [OTHER, 'case-other', false]] as const) {
        await db.insert(catalogItems).values({
          id, partnerId: f.partnerId, name: `${name}-${id.slice(0, 4)}`, sku: `${name}-${id.slice(0, 4)}`,
          itemType: 'service', billingType: 'one_time', isBundle, isActive: true,
          unitPrice: '10.00', costCurrency: 'USD'
        });
      }
    });
    const braced = (u: string) => `{${u}}`;
    const nohyphen = (u: string) => u.replace(/-/g, '');

    // Each accepted spelling must resolve to the SAME row, not 404.
    for (const [label, parent, comp] of [
      ['upper', BUNDLE.toUpperCase(), COMP.toUpperCase()],
      ['braced', braced(BUNDLE), braced(COMP)],
      ['hyphen-less', nohyphen(BUNDLE), nohyphen(COMP)],
    ] as const) {
      await withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
        parent,
        [{ componentItemId: comp, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
        actorFor(f.partnerId)
      ));
      const rows = await getTestDb().execute<{ component_item_id: string }>(sql`
        SELECT component_item_id FROM catalog_bundle_components WHERE bundle_item_id = ${BUNDLE}
      `);
      expect(rows.length, `${label} ids must resolve to the same row`).toBe(1);
      expect(rows[0]!.component_item_id, `${label} component`).toBe(COMP);
    }

    // Same component twice in different cases is a DUPLICATE, not two rows.
    await expect(withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
      BUNDLE,
      [
        { componentItemId: COMP, quantity: 1, showOnInvoice: true, revenueAllocation: null },
        { componentItemId: braced(COMP.toUpperCase()), quantity: 1, showOnInvoice: true, revenueAllocation: null },
      ],
      actorFor(f.partnerId)
    ))).rejects.toMatchObject({ code: 'BUNDLE_DUPLICATE_COMPONENT' });

    // A bundle cannot contain ITSELF under a different spelling either.
    await expect(withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
      BUNDLE,
      [{ componentItemId: nohyphen(BUNDLE.toUpperCase()), quantity: 1, showOnInvoice: true, revenueAllocation: null }],
      actorFor(f.partnerId)
    ))).rejects.toMatchObject({ code: 'BUNDLE_SELF_REFERENCE' });

    // Guard the fixture: `other` is a real sibling item, so the duplicate case
    // above failed on spelling, not because there was only ever one candidate.
    await withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
      BUNDLE,
      [
        { componentItemId: COMP, quantity: 1, showOnInvoice: true, revenueAllocation: null },
        { componentItemId: OTHER.toUpperCase(), quantity: 1, showOnInvoice: true, revenueAllocation: null },
      ],
      actorFor(f.partnerId)
    ));
    expect((await getTestDb().execute(sql`
      SELECT 1 FROM catalog_bundle_components WHERE bundle_item_id = ${BUNDLE}
    `)).length).toBe(2);
  });

  /**
   * Error PRECEDENCE, which the wave-6 representability test cannot detect: it
   * only ever pairs a bad allocation with a GOOD parent, so it passes whether
   * the guard runs before the parent lookup or after it.
   *
   * #3874 shipped the guard after the parent checks. Hoisting it out of the
   * transaction (which the lock rework makes tempting, since it touches no
   * database state) silently inverts that for ordinary HTTP callers — the
   * shared schema accepts `100.50` as plain two-decimal money and does not
   * enforce per-currency minor units, so a request naming a missing parent AND
   * a fractional-yen allocation reaches the service carrying both faults.
   */
  it('reports the parent fault, not the allocation fault, when a request carries both', async () => {
    const f = await seedFixture();
    const fractionalYen = [{
      componentItemId: f.plain, quantity: 1, showOnInvoice: true, revenueAllocation: 100.5,
    }];

    // Missing parent + unrepresentable allocation -> the PARENT error wins.
    await expect(withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
      '00000000-0000-4000-8000-000000000000', fractionalYen, actorFor(f.partnerId), 'JPY'
    ))).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });

    // Non-bundle parent + unrepresentable allocation -> NOT_A_BUNDLE wins.
    await expect(withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
      f.plain, fractionalYen, actorFor(f.partnerId), 'JPY'
    ))).rejects.toMatchObject({ code: 'NOT_A_BUNDLE' });

    // And with a GOOD parent the allocation fault still surfaces, so the two
    // assertions above are about ordering and not about the guard being dead.
    await expect(withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
      f.bundleA, fractionalYen, actorFor(f.partnerId), 'JPY'
    ))).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE' });
  });

  /**
   * The lock must be BOUNDED. Unbounded, this waits indefinitely for up to 201
   * rows from a request path while holding its pooled connection — the failure
   * class that keeps recurring here. Bounded, it becomes a fast 55P03 that the
   * route maps to a retryable 409.
   *
   * Real contention, not a mock: a second connection holds the component row in
   * an open transaction while the compose tries to lock it.
   */
  it('fails fast as ITEM_BUSY instead of waiting forever when an item row is held', async () => {
    const f = await seedFixture();
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    let released!: () => void;
    const releaseGate = new Promise<void>((r) => { released = r; });

    // Hold f.plain FOR UPDATE, then keep the transaction open.
    const holding = holder.begin(async (tx) => {
      await tx`SELECT id FROM catalog_items WHERE id = ${f.plain} FOR UPDATE`;
      await releaseGate;
    });
    // Give the holder time to actually take the lock.
    await new Promise((r) => setTimeout(r, 300));

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
        f.bundleA,
        [{ componentItemId: f.plain, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
        actorFor(f.partnerId),
      ));
    } catch (err) { caught = err; }
    const elapsed = Date.now() - startedAt;

    released();
    await holding;
    await holder.end();

    // The SQLSTATE is on `.cause` (DrizzleQueryError wraps it), which is exactly
    // why the route uses pgErrorCode rather than a top-level `err.code` read.
    expect((caught as { code?: string })?.code).toBe('ITEM_BUSY');
    // And it gave up near the bound rather than hanging on the holder.
    expect(elapsed).toBeLessThan(15000);
  }, 30000);

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
