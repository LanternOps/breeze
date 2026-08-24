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
   * SERVICE maps to a retryable 409 — the route only serialises what it is
   * handed.
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
    // why the SERVICE reads it with pgErrorCode rather than a top-level
    // `err.code`, which would match nothing.
    expect((caught as { code?: string })?.code).toBe('ITEM_BUSY');
    // And it gave up near the bound rather than hanging on the holder.
    expect(elapsed).toBeLessThan(15000);
  }, 30000);

  /**
   * Pins the PRODUCTION WIRING, which the mechanism test in
   * lockTimeoutBounds.integration.test.ts cannot: that one installs the
   * settings itself, so deleting `tightenStatementTimeout` from
   * `lockOwnedItemsInGlobalOrder` leaves it green. So does the contention test
   * above, because it holds ONE row indefinitely and `lock_timeout` alone
   * already covers that case.
   *
   * Asserts ORDER, not end state. An earlier draft of this test read the
   * settings back AFTER the helper returned and asserted they were restored —
   * which passes whether or not they were ever applied, i.e. exactly the defect
   * it was meant to catch.
   */
  it('installs BOTH bounds before the locking query', async () => {
    const f = await seedFixture();
    const statements: string[] = [];

    await withDbAccessContext(ctx(f.partnerId), async () => {
      await db.transaction(async (tx) => {
        // Record what the helper issues, in order.
        const spy = {
          ...tx,
          execute: (q: unknown) => { statements.push(JSON.stringify(q)); return (tx as { execute: (q: unknown) => Promise<unknown> }).execute(q); },
          // The locking query has to be recorded too, or "before" is unprovable.
          // While this passed `select` straight through, the test asserted only
          // that two timeout statements EXIST — moving both tighten calls after
          // the locking query left it green, which is precisely the wiring the
          // test is named for.
          //
          // Traced through a proxy rather than by patching `.for` on the object
          // `select()` returns: the builder is a CHAIN, so `.for` only appears
          // several links along (after from/where/orderBy) and patching the
          // first link silently recorded nothing. `then` is forwarded unwrapped
          // so awaiting the builder still works.
          select: (...args: unknown[]) => {
            const trace = (obj: unknown): unknown => {
              if (obj === null || typeof obj !== 'object') return obj;
              return new Proxy(obj as object, {
                get(target, prop) {
                  const value = Reflect.get(target, prop, target);
                  if (typeof value !== 'function') return value;
                  return (...callArgs: unknown[]) => {
                    // `orderBy` is load-bearing, not cosmetic: the global id
                    // order is what stops two composers forming a cycle.
                    // Nothing recorded it, so deleting it could stay green
                    // whenever Postgres happened to scan the two seeded ids in
                    // the same physical order.
                    if (prop === 'orderBy') statements.push('__LOCKING_ORDER_BY__');
                    if (prop === 'for') statements.push(`__LOCKING_SELECT__ ${String(callArgs[0])}`);
                    const result = (value as (...a: unknown[]) => unknown).apply(target, callArgs);
                    return prop === 'then' ? result : trace(result);
                  };
                },
              });
            };
            return trace((tx as unknown as { select: (...a: unknown[]) => unknown }).select(...args));
          },
        };
        await (svc as unknown as {
          __testables: { lockOwnedItemsInGlobalOrder: (t: unknown, ids: string[], p: string) => Promise<unknown> };
        }).__testables.lockOwnedItemsInGlobalOrder(spy, [f.bundleA, f.plain], f.partnerId);
      });
    });

    // Match the TIGHTEN, not the restore. Both read the same GUC name, and the
    // restore is a bare `set_config` — so a matcher keyed on the name alone
    // finds the restore and passes even when the tighten has been deleted.
    // (Verified: an earlier version of this assertion did exactly that.) The
    // tighten is the only statement that reads `pg_settings` for that GUC.
    const tightened = (guc: string) =>
      statements.findIndex((t) => t.includes('pg_settings') && t.includes(guc));

    expect(tightened('lock_timeout'), 'lock_timeout was never tightened').toBeGreaterThanOrEqual(0);
    expect(tightened('statement_timeout'), 'statement_timeout was never tightened').toBeGreaterThanOrEqual(0);

    // ORDER, which is the whole point: a bound installed after the locking
    // query bounds nothing.
    const lockingAt = statements.findIndex((t) => t.startsWith('__LOCKING_SELECT__'));
    expect(lockingAt, 'the locking select was never issued').toBeGreaterThanOrEqual(0);

    // The MODE, not just that some lock was taken. `.for('share')` survived
    // every other test here: FOR SHARE still conflicts with the FOR UPDATE the
    // contention tests use, so they stayed green — but FOR SHARE does NOT
    // conflict with itself, so two concurrent replacements of the same bundle
    // could both hold the parent, both delete nothing, and both insert, leaving
    // the UNION of two requests from an operation defined as replacement.
    expect(statements[lockingAt], 'the item lock is no longer self-conflicting')
      .toBe('__LOCKING_SELECT__ no key update');

    // ...and it is ordered, before the lock is taken.
    const orderAt = statements.indexOf('__LOCKING_ORDER_BY__');
    expect(orderAt, 'the locking query no longer orders by id').toBeGreaterThanOrEqual(0);
    expect(orderAt).toBeLessThan(lockingAt);
    expect(tightened('lock_timeout'), 'lock_timeout was tightened AFTER the locking query').toBeLessThan(lockingAt);
    expect(tightened('statement_timeout'), 'statement_timeout was tightened AFTER the locking query').toBeLessThan(lockingAt);

    // Both RESTORES must be transaction-scoped. `set_config(..., false)` is
    // session-scoped: it survives the commit and becomes the pooled backend's
    // default for every later request handed that connection.
    //
    // Asserted on the emitted SQL rather than by reading the value back in a
    // second transaction, because that read only observes the leak if the pool
    // happens to hand back the SAME connection — a test that can pass for the
    // wrong reason. (It also cannot see it at all when the restored value
    // equals the default, which is the common case: writing 0 at session scope
    // is indistinguishable from not writing it.)
    // ALL FOUR set_config calls, not just the restores. Checking only the
    // restores left the TIGHTENING free to go session-scoped: the local
    // restore masks it for every in-transaction read, and on commit the pooled
    // backend keeps 3s/4s for whatever request gets that connection next.
    const configs = statements.filter((t) => t.includes('set_config'));
    expect(configs.length, 'expected a tighten and a restore for each bound').toBe(4);
    for (const cfg of configs) {
      expect(cfg, 'a set_config is SESSION-scoped and will outlive the transaction').toContain('true');
    }
  });

  /**
   * The regression guard for the defect this file previously could not see:
   * multi-row contention whose wait is split across acquisitions.
   *
   * `lock_timeout` fires per ACQUISITION, so with two blockers released at
   * different times the second row's timer restarts and the STATEMENT deadline
   * lands first — 57014, not 55P03. Mapping only 55P03 turned that into a 500.
   * Measured directly on PG16 16.14 before this test existed: holders released
   * 700ms apart under lock_timeout=1000ms/statement_timeout=1400ms cancelled at
   * 1412ms with 57014 and never raised 55P03.
   *
   * The single-holder test above cannot catch this — one row held indefinitely
   * is covered by `lock_timeout` alone.
   */
  it('maps a multi-row staggered lock wait to ITEM_LOCK_NOT_ACQUIRED, not a raw cancellation', async () => {
    const f = await seedFixture();
    const holderA = postgres(process.env.DATABASE_URL!, { max: 1 });
    const holderB = postgres(process.env.DATABASE_URL!, { max: 1 });

    // Lock the two rows the compose will take, in the same global (sorted) order
    // the helper uses, so the compose blocks on the FIRST one and then on the
    // SECOND with a fresh timer.
    const sortedIds = [f.bundleA, f.plain].sort();
    const first = sortedIds[0]!;
    const second = sortedIds[1]!;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });

    // Gate on ACQUISITION, not on a sleep. A fixed delay is a guess about how
    // long two connections take to take a row lock; if either has not acquired
    // when the compose starts, the schedule the assertion depends on silently
    // changes and the test proves nothing.
    let firstReady!: () => void;
    let secondReady!: () => void;
    const firstAcquired = new Promise<void>((r) => { firstReady = r; });
    const secondAcquired = new Promise<void>((r) => { secondReady = r; });

    let firstPid = 0;
    const holdingFirst = holderA.begin(async (tx) => {
      const pidRows = await tx`SELECT pg_backend_pid() AS pid`;
      firstPid = Number((pidRows[0] as { pid: number }).pid);
      await tx`SELECT id FROM catalog_items WHERE id = ${first} FOR UPDATE`;
      firstReady();
      await firstGate;
    });
    let secondPid = 0;
    const holdingSecond = holderB.begin(async (tx) => {
      const pidRows = await tx`SELECT pg_backend_pid() AS pid`;
      secondPid = Number((pidRows[0] as { pid: number }).pid);
      await tx`SELECT id FROM catalog_items WHERE id = ${second} FOR UPDATE`;
      secondReady();
      await secondGate;
    });
    await Promise.all([firstAcquired, secondAcquired]);

    /**
     * Wait until some backend is actually BLOCKED BY `blockerPid`.
     *
     * The schedule cannot be driven off a JS timer. Postgres measures its
     * timeouts from when the query message arrives; a `setTimeout` measures
     * from when the promise was submitted, and pool queueing, transaction
     * setup or CI load sit in between. If the first holder is released before
     * the compose has actually blocked on it, the compose only ever waits on
     * ONE row, `lock_timeout` wins, and the test fails against correct code.
     */
    const monitor = postgres(process.env.DATABASE_URL!, { max: 1 });
    // Connect NOW. postgres-js is lazy, so leaving this until the first poll
    // puts connection setup and auth INSIDE the window between the compose
    // starting to wait and this test noticing — time the server is already
    // counting against lock_timeout but the test is not.
    await monitor`SELECT 1`;
    /**
     * Wait until `waiterPid` is blocked specifically BY `blockerPid`.
     *
     * Both pids are named. An earlier version asked only "is anything blocked
     * by the holder", which any other backend touching `catalog_items` could
     * satisfy — the holder's `SELECT ... FOR UPDATE` also takes a table-level
     * RowShare lock, so a parallel DDL in the suite would have answered yes and
     * released the holder before the compose had blocked at all.
     */
    const waitUntilBlockedBy = async (waiterPid: number, blockerPid: number, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = await monitor`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`;
        if ((rows[0] as { blocked: boolean }).blocked) return;
        if (Date.now() > deadline) throw new Error(`pid ${waiterPid} never blocked on ${blockerPid}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    let caught: unknown;
    let sawSecondWait = false;

    // Two things have to be true, and only one of them is a timer.
    //
    // 1. The compose must PROVABLY be waiting on the first row before anything
    //    is released — otherwise the run degenerates to a single lock wait.
    // 2. Some time must then ELAPSE before releasing it, because the whole
    //    point is that the first wait eats into the statement budget while the
    //    second acquisition gets a FRESH per-lock timer. Releasing the instant
    //    it blocks leaves the second wait covered by lock_timeout alone, which
    //    is 55P03 at ~3.2s — measured, not guessed: that is exactly what this
    //    test did before the hold was added.
    //
    // Margins, stated honestly. Let `d` be the lag between the first wait
    // actually beginning on the server and this test observing it.
    //   lower: the hold must exceed 1000ms, or the fresh 3000ms per-lock timer
    //          on the SECOND row expires before the 4000ms statement deadline
    //          and the result is 55P03 instead. HOLD=1800 clears it by 800ms.
    //   upper: d + HOLD must stay under 3000ms, or lock_timeout fires on the
    //          FIRST row before it is released. That leaves only ~1200ms for
    //          `d`, NOT the ~2200ms an earlier version of this comment claimed
    //          by measuring against the wrong deadline.
    // `d` is why the monitor connection is warmed above. Postgres counts from
    // query-message arrival; this test can only count from when it notices.
    const HOLD_MS = 1800;
    try {
      await withDbAccessContext(ctx(f.partnerId), async () => {
        // The composing backend's own pid, read on the SAME pooled connection
        // the service will use (its db.transaction is a savepoint on it), so
        // the poll below can name the waiter instead of accepting any backend.
        const pidRows = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
        const composingPid = Number(
          ((Array.isArray(pidRows) ? pidRows[0] : (pidRows as { rows: unknown[] }).rows[0]) as { pid: number }).pid
        );
        // Neutralise any role/database default: with a stricter effective
        // statement_timeout the helper correctly preserves it, the statement
        // dies on the FIRST row, and this test would pass without ever
        // staggering — a false pass its own subject matter warns about.
        await db.execute(sql`select set_config('statement_timeout', '0', true)`);
        await db.execute(sql`select set_config('lock_timeout', '0', true)`);

        const composing = svc.setBundleComponents(
          f.bundleA,
          [{ componentItemId: f.plain, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
          actorFor(f.partnerId),
        ).catch((err) => { caught = err; });

        await waitUntilBlockedBy(composingPid, firstPid);
        await new Promise((r) => setTimeout(r, HOLD_MS));
        releaseFirst();
        // Now PROVE the second wait happened. Without this the assertion below
        // is satisfied by any 57014 — including one raised while still waiting
        // on the first row, which is not the interleaving this test is named
        // for. There is ~2.2s between the release and the statement deadline,
        // against a 25ms poll.
        await waitUntilBlockedBy(composingPid, secondPid, 3000)
          .then(() => { sawSecondWait = true; })
          .catch(() => { sawSecondWait = false; });
        await composing;
      });
    } finally {
      // BOTH gates, unconditionally. Releasing only the second one meant any
      // throw before `releaseFirst()` — a failed pid read, a rejected poll —
      // left `holdingFirst` unresolved, so cleanup awaited it forever and the
      // suite hung with three clients and two open transactions still holding
      // rows, which then contaminates whatever runs next.
      releaseFirst();
      releaseSecond();
      await holdingFirst.catch(() => {});
      await holdingSecond.catch(() => {});
      await monitor.end().catch(() => {});
      await holderA.end().catch(() => {});
      await holderB.end().catch(() => {});
    }

    // ITEM_LOCK_NOT_ACQUIRED, specifically — it is reachable ONLY through the 57014
    // branch, so this assertion cannot be satisfied by the ordinary 55P03 path.
    // Asserting the generic ITEM_BUSY here would have passed under the old
    // 55P03-only mapping too if timing happened to produce a per-lock timeout,
    // which is exactly the false pass this test exists to avoid.
    // The staggered schedule actually happened: it waited on the first row,
    // acquired it, and was then blocked by the second holder.
    expect(sawSecondWait, 'never blocked on the SECOND row — not a staggered wait').toBe(true);
    expect((caught as { code?: string })?.code).toBe('ITEM_LOCK_NOT_ACQUIRED');
    // 409, not 5xx — see the code's comment: status drives HighErrorRate.
    expect((caught as { status?: number })?.status).toBe(409);
  }, 30000);

  /**
   * After an ITEM_BUSY the OUTER request transaction must still be usable, and
   * must not have inherited the tightened timeouts.
   *
   * Both halves can fail silently. The locking helper deliberately restores the
   * GUCs only on the success path, on the reasoning that a failure aborts the
   * subtransaction and rolling back to the savepoint undoes the `SET LOCAL`
   * anyway — that reasoning is load-bearing and was never asserted. If it were
   * wrong, a contended compose would leave a 3s/4s deadline governing the rest
   * of the caller's request, which is a much broader promise than this bound
   * makes and would surface far from here.
   */
  it('leaves the outer transaction usable and the timeouts restored after ITEM_BUSY', async () => {
    const f = await seedFixture();
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { acquired = r; });

    const holding = holder.begin(async (tx) => {
      await tx`SELECT id FROM catalog_items WHERE id = ${f.plain} FOR UPDATE`;
      acquired();
      await gate;
    });
    await ready;

    let caught: unknown;
    let after: { lock: string; stmt: string } | undefined;

    await withDbAccessContext(ctx(f.partnerId), async () => {
      await db.transaction(async (outer) => {
        // Record what the OUTER transaction had before any of this ran.
        const before = await outer.execute(
          sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`
        );
        const prior = (Array.isArray(before) ? before[0] : (before as { rows: unknown[] }).rows[0]) as { lock: string; stmt: string };

        try {
          await svc.setBundleComponents(
            f.bundleA,
            [{ componentItemId: f.plain, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
            actorFor(f.partnerId),
          );
        } catch (err) { caught = err; }

        // The outer transaction must still accept work. If the savepoint had
        // not absorbed the abort this throws 25P02 instead.
        const rows = await outer.execute(
          sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`
        );
        after = (Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows[0]) as { lock: string; stmt: string };
        expect(after).toEqual(prior);
      });
    });

    release();
    await holding;
    await holder.end();

    expect((caught as { code?: string })?.code).toBe('ITEM_BUSY');
    // Not left at the helper's bounds.
    expect(after?.stmt).not.toBe('4s');
    expect(after?.lock).not.toBe('3s');
  }, 30000);

  /**
   * The SUCCESS-path restore, and the first test here to look at end state at
   * all: the ordering test deliberately stopped doing so, and the failure-path
   * tests roll the savepoint back, which undoes the SET LOCAL whether or not a
   * restore exists. (The four-`set_config` assertion and the crossed-value
   * tests below now also catch a deleted restore; when this test was written it
   * was the only thing that did.)
   *
   * Left un-restored, the helper's 4s deadline governs the rest of the caller's
   * request transaction — the unlocked read, the replace DML, and everything
   * after — so a slow later statement becomes a raw 57014 outside the narrow
   * catch, far from anything that mentions catalog locks.
   */
  it('restores both outer timeouts after the lock helper succeeds', async () => {
    const f = await seedFixture();
    let before!: { lock: string; stmt: string };
    let after!: { lock: string; stmt: string };
    const read = async (tx: { execute: (q: never) => Promise<unknown> }) => {
      const r = await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`
      );
      return (Array.isArray(r) ? r[0] : (r as { rows: unknown[] }).rows[0]) as { lock: string; stmt: string };
    };

    await withDbAccessContext(ctx(f.partnerId), async () => {
      await db.transaction(async (outer) => {
        // Give the outer transaction a deadline of its own, so this asserts the
        // caller's value is put back rather than merely that some value is set.
        await outer.execute(sql`select set_config('statement_timeout', '9s', true)`);
        await outer.execute(sql`select set_config('lock_timeout', '8s', true)`);
        before = await read(outer as never);

        await (svc as unknown as {
          __testables: { lockOwnedItemsInGlobalOrder: (t: unknown, ids: string[], p: string) => Promise<unknown> };
        }).__testables.lockOwnedItemsInGlobalOrder(outer, [f.bundleA, f.plain], f.partnerId);

        after = await read(outer as never);
      });
    });

    expect(before).toEqual({ lock: '8s', stmt: '9s' });
    expect(after, 'the helper leaked its own bounds into the caller').toEqual(before);
  });

  /**
   * NEVER-WIDEN, for the STATEMENT helper specifically, and with the two
   * settings on OPPOSITE sides of their bounds.
   *
   * Both of those matter, and the 8s/9s test above proves neither:
   *
   *  - 8s and 9s are BOTH looser than their bounds, so that test only ever
   *    exercises tighten-then-restore. Replacing `tightenStatementTimeout`'s
   *    whole CASE with an unconditional `${boundMs}` survives it — and survives
   *    the device-deletion never-widen test too, because device deletion never
   *    calls the statement helper at all. The production failure is silent: an
   *    outer 2s deadline becomes 4s, and since `lockTimeoutWasChanged(2000,
   *    4000)` is false the helper does not restore it either, so the WIDENED
   *    value stays in force for the rest of the caller's transaction.
   *
   *  - With lock and statement on opposite sides, restoring the statement
   *    setting off the LOCK helper's prior value (`priorMs` instead of
   *    `priorStmtMs`) is also caught: that predicate would read 2s-vs-4s,
   *    conclude nothing changed, skip the restore, and leak 4s.
   */
  it('preserves a stricter outer statement_timeout and still restores a looser lock_timeout', async () => {
    const f = await seedFixture();
    let before!: { lock: string; stmt: string };
    let after!: { lock: string; stmt: string };
    const read = async (tx: { execute: (q: never) => Promise<unknown> }) => {
      const r = await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`
      );
      return (Array.isArray(r) ? r[0] : (r as { rows: unknown[] }).rows[0]) as { lock: string; stmt: string };
    };

    await withDbAccessContext(ctx(f.partnerId), async () => {
      await db.transaction(async (outer) => {
        // statement 2s is STRICTER than the 4s bound -> must be left alone.
        // lock 8s is LOOSER than the 3s bound -> must be tightened, then restored.
        await outer.execute(sql`select set_config('statement_timeout', '2s', true)`);
        await outer.execute(sql`select set_config('lock_timeout', '8s', true)`);
        before = await read(outer as never);

        await (svc as unknown as {
          __testables: { lockOwnedItemsInGlobalOrder: (t: unknown, ids: string[], p: string) => Promise<unknown> };
        }).__testables.lockOwnedItemsInGlobalOrder(outer, [f.bundleA, f.plain], f.partnerId);

        after = await read(outer as never);
      });
    });

    expect(before).toEqual({ lock: '8s', stmt: '2s' });
    expect(after.stmt, 'a stricter outer statement_timeout was WIDENED').toBe('2s');
    expect(after.lock, 'the looser outer lock_timeout was not restored').toBe('8s');
  });

  /**
   * The MIRROR of the case above, and it is not redundant.
   *
   * Restoring the statement setting off the LOCK helper's prior value
   * (`lockTimeoutWasChanged(priorMs, ...)` instead of `priorStmtMs`) survives
   * every other arrangement here. It survives 8s/9s because both are looser, so
   * both predicates agree. It survives 8s/2s because although the wrong
   * predicate flips to true, the restore still WRITES `priorStmtMs` — it
   * rewrites 2s as 2s and nothing is observable.
   *
   * Only lock-stricter / statement-looser separates them: the wrong predicate
   * reads 2s-vs-4s, concludes nothing changed, SKIPS the statement restore, and
   * leaves the helper's own 4s bound governing the rest of the transaction.
   */
  it('restores a looser outer statement_timeout when the lock_timeout was stricter', async () => {
    const f = await seedFixture();
    let after!: { lock: string; stmt: string };
    const read = async (tx: { execute: (q: never) => Promise<unknown> }) => {
      const r = await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`
      );
      return (Array.isArray(r) ? r[0] : (r as { rows: unknown[] }).rows[0]) as { lock: string; stmt: string };
    };

    await withDbAccessContext(ctx(f.partnerId), async () => {
      await db.transaction(async (outer) => {
        // lock 2s is STRICTER than the 3s bound -> left alone.
        // statement 9s is LOOSER than the 4s bound -> tightened, must be restored.
        await outer.execute(sql`select set_config('lock_timeout', '2s', true)`);
        await outer.execute(sql`select set_config('statement_timeout', '9s', true)`);

        await (svc as unknown as {
          __testables: { lockOwnedItemsInGlobalOrder: (t: unknown, ids: string[], p: string) => Promise<unknown> };
        }).__testables.lockOwnedItemsInGlobalOrder(outer, [f.bundleA, f.plain], f.partnerId);

        after = await read(outer as never);
      });
    });

    expect(after.lock, 'a stricter outer lock_timeout was WIDENED').toBe('2s');
    expect(after.stmt, "the helper's 4s bound leaked past the lock step").toBe('9s');
  });

  /**
   * The DEFAULT case, which every other restore test misses.
   *
   * Postgres ships both GUCs at `0` (disabled), so 0/0 is the default a
   * deployment starts from unless a role or database default overrides it —
   * and all three tests above use non-zero outer values.
   * That gap lets `lockTimeoutWasChanged` drop its `priorMs === 0` arm and
   * survive: the SQL still tightens 0 to 3s/4s, the predicate then reports
   * "nothing changed", and NEITHER restore runs. Ordinary successful bundle
   * composition would leave 3s/4s governing the rest of the request — and the
   * same helper backs the device cascade, so it would leak there too.
   *
   * Asserts `0`, not merely "unchanged": the tightening is real, so this only
   * passes if both values were actually put back.
   */
  it('restores both timeouts to 0 when the caller had the Postgres defaults', async () => {
    const f = await seedFixture();
    let after!: { lock: string; stmt: string };

    await withDbAccessContext(ctx(f.partnerId), async () => {
      await db.transaction(async (outer) => {
        await outer.execute(sql`select set_config('lock_timeout', '0', true)`);
        await outer.execute(sql`select set_config('statement_timeout', '0', true)`);

        await (svc as unknown as {
          __testables: { lockOwnedItemsInGlobalOrder: (t: unknown, ids: string[], p: string) => Promise<unknown> };
        }).__testables.lockOwnedItemsInGlobalOrder(outer, [f.bundleA, f.plain], f.partnerId);

        const r = await (outer as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
          sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`
        );
        after = (Array.isArray(r) ? r[0] : (r as { rows: unknown[] }).rows[0]) as { lock: string; stmt: string };
      });
    });

    expect(after.lock, 'lock_timeout was left at the helper bound').toBe('0');
    expect(after.stmt, 'statement_timeout was left at the helper bound').toBe('0');
  });

  /**
   * The lock must cover the REQUESTED ids only — not the caller's whole catalog.
   *
   * Dropping `inArray(catalogItems.id, ordered)` and filtering on `partnerId`
   * alone survives every other test here: the proxy records `.orderBy` and
   * `.for` but never `.where`, and every other case only ever touches items the
   * request already names. In production that mutation locks the partner's
   * ENTIRE catalog for the duration of one bundle edit, so unrelated concurrent
   * edits collide — the exact contention this PR exists to remove, made worse.
   *
   * Behavioural, and needs no timing barrier: an unrelated same-partner row is
   * held for the whole compose. Correct code never asks for it and succeeds;
   * the over-broad mutation blocks on it and fails.
   */
  it('locks only the requested ids, not the whole partner catalog', async () => {
    const f = await seedFixture();
    // A fourth item, same partner, NOT referenced by the compose below.
    const unrelated = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(catalogItems).values({
        partnerId: f.partnerId, name: `unrelated-${Date.now()}`, sku: `unrelated-${Date.now()}`,
        itemType: 'service', billingType: 'one_time', isBundle: false, isActive: true,
        unitPrice: '10.00', costCurrency: 'USD'
      }).returning({ id: catalogItems.id });
      return row!.id;
    });

    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { acquired = r; });
    const holding = holder.begin(async (tx) => {
      await tx`SELECT id FROM catalog_items WHERE id = ${unrelated} FOR UPDATE`;
      acquired();
      await gate;
    });

    try {
      await ready;
      // Composes bundleA from `plain`. `unrelated` is not named anywhere.
      await withDbAccessContext(ctx(f.partnerId), () => svc.setBundleComponents(
        f.bundleA,
        [{ componentItemId: f.plain, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
        actorFor(f.partnerId),
      ));
    } finally {
      release();
      await holding.catch(() => {});
      await holder.end().catch(() => {});
    }
  }, 30000);

  /**
   * A non-lock SQLSTATE must pass straight through.
   *
   * Widening the guard from `code === '57014'` to a bare `if (code)` survives
   * every other test here, because nothing else makes the locking query fail
   * for a non-lock reason. It would turn 42501 (insufficient_privilege), 40P01
   * (deadlock_detected) and the 08xxx connection classes into a friendly 409
   * "could not acquire the locks, try again" — advice that is wrong for all
   * three, and which, because the route serialises a CatalogServiceError
   * instead of throwing, never reaches Sentry either.
   *
   * Driven through a stub rather than a real privilege error: the point is the
   * SQLSTATE branch, and the error is shaped the way Drizzle actually delivers
   * one (code on `.cause`, not on the error itself).
   */
  it('lets a non-lock SQLSTATE propagate instead of mapping it to a lock failure', async () => {
    const wrapped = Object.assign(new Error('permission denied for table catalog_items'), {
      cause: { code: '42501' },
    });
    const priorRow = [{ prior_ms: '0' }];
    const stubTx = {
      execute: async () => priorRow,
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ for: () => { throw wrapped; } }),
          }),
        }),
      }),
    };

    await expect(
      (svc as unknown as {
        __testables: { lockOwnedItemsInGlobalOrder: (t: unknown, ids: string[], p: string) => Promise<unknown> };
      }).__testables.lockOwnedItemsInGlobalOrder(
        stubTx,
        ['11111111-1111-4111-8111-111111111111'],
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toBe(wrapped);
  });

  /**
   * A FOREIGN component must be read UNLOCKED — the partner filter on the
   * locking query is load-bearing, not incidental.
   *
   * Dropping `eq(catalogItems.partnerId, partnerId)` survives every other test
   * here, because nothing else names an item this partner does not own. The
   * damage is specific: an INVALID cross-partner request from partner A would
   * take a row lock on partner B's item before rejecting, so a request that is
   * about to 400 can block partner B's legitimate work — or, if B holds it,
   * come back as a lock failure instead of the validation error that explains
   * what the caller actually did wrong.
   *
   * This is the same invariant that decided the design: CROSS_PARTNER needs the
   * foreign row VISIBLE, not LOCKED. The dual-partner context is required for
   * the row to be visible at all — under a single-partner RLS axis the lookup
   * returns nothing and the service says COMPONENT_NOT_FOUND long before it
   * reaches the cross-partner branch.
   */
  it('does not lock a foreign component when rejecting a cross-partner request', async () => {
    const f = await seedFixture();
    const suffix = Math.random().toString(36).slice(2, 10);
    const foreign = await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({
        name: `Bundle race foreign ${suffix}`, slug: `bundle-race-foreign-${suffix}`,
        type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD'
      }).returning({ id: partners.id });
      const [row] = await db.insert(catalogItems).values({
        partnerId: p!.id, name: `foreign-${suffix}`, sku: `foreign-${suffix}`,
        itemType: 'service', billingType: 'one_time', isBundle: false, isActive: true,
        unitPrice: '10.00', costCurrency: 'USD'
      }).returning({ id: catalogItems.id });
      return { partnerId: p!.id, itemId: row!.id };
    });

    // Partner B holds its own row for the whole request.
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { acquired = r; });
    const holding = holder.begin(async (tx) => {
      await tx`SELECT id FROM catalog_items WHERE id = ${foreign.itemId} FOR UPDATE`;
      acquired();
      await gate;
    });

    const dualCtx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [],
      accessiblePartnerIds: [f.partnerId, foreign.partnerId], userId: null,
    };

    try {
      await ready;
      // Must be the VALIDATION error, promptly — not a lock failure.
      await expect(
        withDbAccessContext(dualCtx, () => svc.setBundleComponents(
          f.bundleA,
          [{ componentItemId: foreign.itemId, quantity: 1, showOnInvoice: true, revenueAllocation: null }],
          actorFor(f.partnerId),
        ))
      ).rejects.toMatchObject({ code: 'BUNDLE_CROSS_PARTNER' });
    } finally {
      release();
      await holding.catch(() => {});
      await holder.end().catch(() => {});
    }
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
