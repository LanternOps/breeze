/**
 * Functional cross-tenant RLS + constraint forge tests for quote_orders /
 * quote_order_lines (Task 12).
 *
 * SECURITY-CRITICAL. The rls-coverage contract test (Task 6/existing suite)
 * only proves the policies EXIST in pg_catalog; it does NOT prove a real
 * cross-tenant write is rejected at runtime, nor that the composite FKs and
 * CHECK constraint added in 2026-08-03-b-quote-orders.sql actually hold. This
 * file is the behavioral guard: it runs code-under-test as the unprivileged
 * `breeze_app` role (rolbypassrls=f) so RLS is actually enforced, and asserts
 * that a forged write for another org is denied, cross-tenant reads are
 * invisible, and the composite FK / qty CHECK constraints on quote_order_lines
 * reject bad data with the expected SQLSTATEs.
 *
 * Scope note: this file is the breeze_app RLS/constraint forge layer only.
 * quoteOrderService.integration.test.ts (Task 11) already covers the
 * service-level behavior (idempotency, 409/400 status codes, cancel/receipt
 * guards) under a real DB but does not run as an unprivileged role forging
 * cross-tenant writes — do not duplicate those cases here.
 *
 * Runs under vitest.integration.config.ts. Mirrors quotes-rls.integration.test.ts:
 * fresh fixture per test (setup.ts's beforeEach TRUNCATEs partners/organizations
 * CASCADE, so a module-level cache would hand later tests deleted rows and make
 * the cross-tenant assertions vacuous).
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS so the seed can write the partner/org/quote/line rows):
 *   partnerA -> orgA           (the caller's tenant)
 *   partnerB -> orgB           (the foreign tenant)
 *   quoteA/lineA under orgA    (the caller's own quote + line, for positive
 *                                controls and the CHECK-violation case)
 *   quoteA2/lineA2 under orgA  (a SECOND orgA quote+line, same org so RLS
 *                                admits it, but a different quote — used by
 *                                the mismatched-quote composite-FK case)
 *   quoteB under orgB          (the foreign tenant's quote, used by the
 *                                cross-org INSERT/SELECT forge cases)
 *
 * quote_orders / quote_order_lines use shape-1 org-axis RLS
 * (breeze_has_org_access(org_id), INSERT WITH CHECK + SELECT/UPDATE/DELETE
 * USING) per the 2026-08-03-b-quote-orders.sql migration.
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
import { quotes, quoteLines, quoteOrders, quoteOrderLines } from '../../db/schema/quotes';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  /** orgA's own quote + line — used for positive controls and the CHECK case. */
  quoteA: { id: string };
  lineA: { id: string };
  /** A SECOND orgA quote + line, distinct from quoteA — the mismatched-quote
   *  FK forge case references this line while claiming quoteA's id. */
  quoteA2: { id: string };
  lineA2: { id: string };
  /** A quotes row owned by orgB, used by the cross-org INSERT/SELECT cases. */
  quoteB: { id: string };
  /** breeze_app context scoped to org A (mirrors authMiddleware org scope). */
  orgAContext: DbAccessContext;
}

// Re-seeds fresh on every call. Intentionally NOT memoized — see file header.
async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const [quoteA] = await db
      .insert(quotes)
      .values({ partnerId: partnerA.id, orgId: orgA.id, currencyCode: 'USD' })
      .returning({ id: quotes.id });
    if (!quoteA) throw new Error('failed to seed orgA quote');
    const [lineA] = await db
      .insert(quoteLines)
      .values({
        quoteId: quoteA.id,
        orgId: orgA.id,
        sourceType: 'manual',
        description: 'Managed switch',
        quantity: '10',
        unitPrice: '20.00',
        lineTotal: '200.00',
        recurrence: 'one_time',
      })
      .returning({ id: quoteLines.id });
    if (!lineA) throw new Error('failed to seed orgA quote line');

    // A second, unrelated orgA quote + line — FK-valid org, but a DIFFERENT
    // quote than quoteA. Used to prove the composite (quote_line_id, quote_id)
    // FK rejects a line that doesn't belong to the claimed quote.
    const [quoteA2] = await db
      .insert(quotes)
      .values({ partnerId: partnerA.id, orgId: orgA.id, currencyCode: 'USD' })
      .returning({ id: quotes.id });
    if (!quoteA2) throw new Error('failed to seed second orgA quote');
    const [lineA2] = await db
      .insert(quoteLines)
      .values({
        quoteId: quoteA2.id,
        orgId: orgA.id,
        sourceType: 'manual',
        description: 'Rack-mount router',
        quantity: '5',
        unitPrice: '30.00',
        lineTotal: '150.00',
        recurrence: 'one_time',
      })
      .returning({ id: quoteLines.id });
    if (!lineA2) throw new Error('failed to seed second orgA quote line');

    // A quote owned by orgB, written under system scope (bypasses RLS for the
    // seed). Used by the cross-org INSERT/SELECT forge cases.
    const [quoteB] = await db
      .insert(quotes)
      .values({ partnerId: partnerB.id, orgId: orgB.id, currencyCode: 'USD' })
      .returning({ id: quotes.id });
    if (!quoteB) throw new Error('failed to seed orgB quote');

    // Org-scoped breeze_app context for org A. quote_orders/quote_order_lines
    // are org-axis RLS, so the accessible-org axis must list orgA for the
    // breeze_app insert/select to pass — this mirrors how request middleware
    // populates an org-scoped ctx.
    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      quoteA: { id: quoteA.id },
      lineA: { id: lineA.id },
      quoteA2: { id: quoteA2.id },
      lineA2: { id: lineA2.id },
      quoteB: { id: quoteB.id },
      orgAContext,
    };
  });
}

describe('quote_orders / quote_order_lines RLS + constraint forge (breeze_app)', () => {
  // (1) Cross-tenant INSERT denied + positive control. Under an orgA-scoped
  // breeze_app context, inserting a quote_orders row for orgB's real quote is
  // rejected by the INSERT WITH CHECK policy (quoteB/orgB are real seeded
  // rows, so their FKs resolve — a 42501, not a 23503, is what proves RLS is
  // the gate). The same shape targeting orgA's own quote succeeds, proving the
  // policy isn't simply deny-everything (which would make the forge pass for
  // the wrong reason).
  runDb(
    'blocks a forged cross-tenant quote_orders INSERT for another org (42501); same-org insert succeeds',
    async () => {
      const fx = await seedFixture();

      await expect(
        withDbAccessContext(fx.orgAContext, () =>
          db.insert(quoteOrders).values({
            quoteId: fx.quoteB.id, // orgB's real quote (FK resolves)
            orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
            procurementSource: 'manual',
          })
        )
      ).rejects.toMatchObject({ cause: { code: '42501' } });

      const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
        db
          .insert(quoteOrders)
          .values({ quoteId: fx.quoteA.id, orgId: fx.orgA.id, procurementSource: 'manual' })
          .returning({ id: quoteOrders.id, orgId: quoteOrders.orgId })
      );
      expect(inserted?.orgId).toBe(fx.orgA.id);
    }
  );

  // (2) Allocation INSERT referencing another quote's line (FK-valid org,
  // mismatched quote) -> composite FK violation (23503). lineA2 is a real,
  // same-org (orgA) quote_lines row, so the org-axis RLS check on the insert
  // passes — but it belongs to quoteA2, not quoteA. The composite FK
  // (quote_line_id, quote_id) -> quote_lines(id, quote_id) can't resolve the
  // (lineA2.id, quoteA.id) pair, so this must fail with 23503 (not 42501),
  // proving the FK independently guards against cross-quote leakage within
  // the same tenant — RLS alone would not catch this.
  runDb("allocation INSERT referencing another quote's line (FK-valid org, mismatched quote) -> 23503", async () => {
    const fx = await seedFixture();

    const [order] = await withDbAccessContext(fx.orgAContext, () =>
      db.insert(quoteOrders).values({ quoteId: fx.quoteA.id, orgId: fx.orgA.id }).returning({ id: quoteOrders.id })
    );
    if (!order) throw new Error('failed to insert base order');

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(quoteOrderLines).values({
          orderId: order.id,
          quoteId: fx.quoteA.id, // claimed quote
          orgId: fx.orgA.id,
          quoteLineId: fx.lineA2.id, // real line, but belongs to quoteA2 — mismatch
          orderedQty: '1',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  // (3) Allocation with received_qty > ordered_qty -> 23514 CHECK violation
  // (quote_order_lines_qty_chk). Both FKs resolve (real order + real line
  // belonging to the claimed quote), isolating the failure to the CHECK.
  runDb('allocation with received_qty > ordered_qty -> 23514 CHECK violation', async () => {
    const fx = await seedFixture();

    const [order] = await withDbAccessContext(fx.orgAContext, () =>
      db.insert(quoteOrders).values({ quoteId: fx.quoteA.id, orgId: fx.orgA.id }).returning({ id: quoteOrders.id })
    );
    if (!order) throw new Error('failed to insert base order');

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(quoteOrderLines).values({
          orderId: order.id,
          quoteId: fx.quoteA.id,
          orgId: fx.orgA.id,
          quoteLineId: fx.lineA.id,
          orderedQty: '2',
          receivedQty: '5', // > orderedQty — violates quote_order_lines_qty_chk
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  // (4) Cross-org SELECT hidden (silent zero-row read, not an error). orgB's
  // quote_orders row is invisible to an orgA caller. The system-scope probe
  // first confirms the row really exists, so the 0-row read under orgA is
  // meaningfully "RLS hid it", not "it was never created".
  runDb('hides another org quote_orders from SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    const seededId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(quoteOrders)
        .values({ quoteId: fx.quoteB.id, orgId: fx.orgB.id, procurementSource: 'manual' })
        .returning({ id: quoteOrders.id });
      return row!.id;
    });

    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select({ id: quoteOrders.id }).from(quoteOrders).where(eq(quoteOrders.id, seededId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: quoteOrders.id }).from(quoteOrders).where(eq(quoteOrders.id, seededId))
    );
    expect(visibleToA).toHaveLength(0);
  });
});
