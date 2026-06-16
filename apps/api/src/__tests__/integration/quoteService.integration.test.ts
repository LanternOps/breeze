/**
 * Real-driver service-layer tests for the quote engine (Task 8).
 *
 * Runs under vitest.integration.config.ts — the service-under-test connects
 * through the `db` proxy, which inside a `withDbAccessContext(...)` call uses
 * the unprivileged `breeze_app` role (rolbypassrls=f). So the CRUD/line/block
 * logic, the snapshot-on-add behavior, the totals recompute, AND the partner/
 * org RLS isolation are exercised against a real Postgres, not a mock.
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS so the seed can write the partner/org/catalog rows):
 *   partnerA → orgA
 *
 * Why NO memoization: integration/setup.ts runs cleanupDatabase() in a
 * beforeEach that TRUNCATE ... CASCADEs partners/organizations before every
 * test, cascading through the quote + catalog FKs. A cached fixture would hand
 * later tests rows that no longer exist, making assertions vacuous. Each test
 * re-seeds — matching every sibling *.integration.test.ts.
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
import { quotes, quoteLines } from '../../db/schema/quotes';
import { catalogItems } from '../../db/schema/catalog';
import { createOrganization, createPartner } from './db-utils';
import {
  createQuote,
  getQuote,
  addBlock,
  deleteBlock,
  addManualLine,
  addCatalogLine,
  updateLine,
  removeLine,
  updateQuote,
  deleteDraftQuote,
} from '../../services/quoteService';
import { createCatalogItem, getCatalogItem, type CatalogActor } from '../../services/catalogService';
import { type QuoteActor } from '../../services/quoteTypes';
import { computeQuoteTotals } from '../../services/quoteMath';
import { toCents } from '../../services/invoiceMath';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  /** A partner-A actor with unrestricted org access (accessibleOrgIds=null). */
  actorA: QuoteActor;
  /** Partner-A DB context so service writes run under partner-A RLS. */
  ctxA: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });

    const actorA: QuoteActor = {
      userId: null, // createdBy nullable; no real user row needed
      partnerId: partnerA.id,
      accessibleOrgIds: null, // unrestricted at the app layer (partner-admin style)
    };

    // quotes/quote_lines/quote_blocks use ORG-AXIS RLS
    // (breeze_has_org_access(org_id)), so the DB context must list orgA on the
    // accessible-org axis for the breeze_app insert/select/update to pass — a
    // partner-scope context alone does NOT grant org access here. This mirrors
    // how the request middleware populates accessibleOrgIds for a partner admin.
    const ctxA: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    return { partnerA: { id: partnerA.id }, orgA: { id: orgA.id }, actorA, ctxA };
  });
}

/** Seed a catalog item directly under system scope (bypasses RLS for the seed). */
async function seedCatalogItem(
  partnerId: string,
  values: Partial<typeof catalogItems.$inferInsert> & { name: string; unitPrice: string }
): Promise<{ id: string }> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(catalogItems).values({
      partnerId,
      itemType: 'service',
      name: values.name,
      unitPrice: values.unitPrice,
      billingType: values.billingType ?? 'one_time',
      billingFrequency: values.billingFrequency ?? null,
      commitmentTermMonths: values.commitmentTermMonths ?? null,
      taxable: values.taxable ?? true,
      isBundle: false,
    }).returning({ id: catalogItems.id });
    return { id: row!.id };
  });
}

describe('quoteService (breeze_app, real DB)', () => {
  runDb('createQuote → getQuote returns a draft', async () => {
    const fx = await seedFixture();
    const created = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    expect(created.status).toBe('draft');
    expect(created.orgId).toBe(fx.orgA.id);
    expect(created.partnerId).toBe(fx.partnerA.id);

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(created.id, fx.actorA));
    expect(fetched.quote.id).toBe(created.id);
    expect(fetched.quote.status).toBe('draft');
    expect(fetched.blocks).toHaveLength(0);
    expect(fetched.lines).toHaveLength(0);
  });

  runDb('addManualLine persists the line and updates subtotal/oneTimeTotal', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );

    const line = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual',
        description: 'Onboarding fee',
        quantity: 3,
        unitPrice: 100,
        taxable: false,
        customerVisible: true,
        recurrence: 'one_time',
      }, fx.actorA)
    );
    expect(line.lineTotal).toBe('300.00'); // 3 * 100.00 via computeLineTotal

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(fetched.lines).toHaveLength(1);
    expect(fetched.quote.subtotal).toBe('300.00');
    expect(fetched.quote.oneTimeTotal).toBe('300.00');
    expect(fetched.quote.monthlyRecurringTotal).toBe('0.00');
    expect(fetched.quote.annualRecurringTotal).toBe('0.00');
  });

  runDb('addCatalogLine snapshots a recurring item (recurrence/term/price/MRR)', async () => {
    const fx = await seedFixture();
    const item = await seedCatalogItem(fx.partnerA.id, {
      name: 'Managed endpoint',
      unitPrice: '49.99',
      billingType: 'recurring',
      billingFrequency: 'monthly',
      commitmentTermMonths: 12,
      taxable: true,
    });
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );

    const line = await withDbAccessContext(fx.ctxA, () =>
      addCatalogLine(quote.id, item.id, 10, undefined, fx.actorA)
    );
    // Snapshotted from the catalog item.
    expect(line.recurrence).toBe('monthly');
    expect(line.termMonths).toBe(12);
    expect(line.unitPrice).toBe('49.99');
    expect(line.billingFrequency).toBe('monthly');
    expect(line.description).toBe('Managed endpoint');
    expect(line.sourceType).toBe('catalog');
    expect(line.catalogItemId).toBe(item.id);
    expect(line.taxable).toBe(true);
    expect(line.lineTotal).toBe('499.90'); // 10 * 49.99

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(fetched.quote.monthlyRecurringTotal).toBe('499.90');
    expect(fetched.quote.oneTimeTotal).toBe('0.00');
    // First-period basis: subtotal includes the first monthly period.
    expect(fetched.quote.subtotal).toBe('499.90');
  });

  runDb('updateLine recomputes totals; removeLine recomputes again', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const line = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Widget', quantity: 2, unitPrice: 50,
        taxable: false, customerVisible: true, recurrence: 'one_time',
      }, fx.actorA)
    );
    let fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(fetched.quote.subtotal).toBe('100.00'); // 2 * 50

    // Bump quantity 2 → 5 ⇒ 250.00
    const updated = await withDbAccessContext(fx.ctxA, () =>
      updateLine(quote.id, line.id, { quantity: 5 }, fx.actorA)
    );
    expect(updated.lineTotal).toBe('250.00');
    fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(fetched.quote.subtotal).toBe('250.00');
    expect(fetched.quote.oneTimeTotal).toBe('250.00');

    // Remove the only line ⇒ everything back to zero.
    await withDbAccessContext(fx.ctxA, () => removeLine(quote.id, line.id, fx.actorA));
    fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(fetched.lines).toHaveLength(0);
    expect(fetched.quote.subtotal).toBe('0.00');
    expect(fetched.quote.oneTimeTotal).toBe('0.00');
  });

  runDb('updateQuote on a non-draft quote throws NOT_A_DRAFT (409)', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    // Flip status to 'sent' under system scope (the lifecycle transition that
    // Phase 1's send flow performs; here done directly so we can exercise the
    // draft-only guard without standing up the whole issue path).
    await withSystemDbAccessContext(() =>
      db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quote.id))
    );

    await expect(
      withDbAccessContext(fx.ctxA, () =>
        updateQuote(quote.id, { introNotes: 'edit after send' }, fx.actorA)
      )
    ).rejects.toMatchObject({ status: 409, code: 'NOT_A_DRAFT' });

    // deleteDraftQuote must likewise refuse a non-draft.
    await expect(
      withDbAccessContext(fx.ctxA, () => deleteDraftQuote(quote.id, fx.actorA))
    ).rejects.toMatchObject({ status: 409, code: 'NOT_A_DRAFT' });
  });

  runDb('deleteDraftQuote removes a draft (and its lines cascade)', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Doomed line', quantity: 1, unitPrice: 10,
        taxable: false, customerVisible: true, recurrence: 'one_time',
      }, fx.actorA)
    );

    await withDbAccessContext(fx.ctxA, () => deleteDraftQuote(quote.id, fx.actorA));

    const remaining = await withSystemDbAccessContext(() =>
      db.select().from(quotes).where(eq(quotes.id, quote.id))
    );
    expect(remaining).toHaveLength(0);
    const remainingLines = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id))
    );
    expect(remainingLines).toHaveLength(0);
  });

  runDb('Σ(line lineTotal) == quote.subtotal for a mix of customer-visible lines (penny-consistency)', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    // A deliberately fractional mix: 3 * 0.335 = 1.005 → 1.01 via round-half-up,
    // plus a recurring line, plus a hidden (customer_visible=false) line that
    // must NOT count toward the subtotal.
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Sub-cent unit price', quantity: 3, unitPrice: 0.34,
        taxable: false, customerVisible: true, recurrence: 'one_time',
      }, fx.actorA)
    );
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Monthly seat', quantity: 7, unitPrice: 12.50,
        taxable: false, customerVisible: true, recurrence: 'monthly',
      }, fx.actorA)
    );
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Internal cost (hidden)', quantity: 1, unitPrice: 999.99,
        taxable: false, customerVisible: false, recurrence: 'one_time',
      }, fx.actorA)
    );

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    // Sum the persisted line_total of ONLY the customer-visible lines (matches
    // computeQuoteTotals, which skips hidden lines), in integer cents.
    const visibleCents = fetched.lines
      .filter((l) => l.customerVisible)
      .reduce((acc, l) => acc + toCents(l.lineTotal), 0);
    expect(toCents(fetched.quote.subtotal)).toBe(visibleCents);

    // Cross-check the header against an independent recompute from the lines.
    const expected = computeQuoteTotals(
      fetched.lines.map((l) => ({
        quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable,
        customerVisible: l.customerVisible, recurrence: l.recurrence,
      })),
      null
    );
    expect(fetched.quote.subtotal).toBe(expected.subtotal);
    expect(fetched.quote.oneTimeTotal).toBe(expected.oneTimeTotal);
    expect(fetched.quote.monthlyRecurringTotal).toBe(expected.monthlyRecurringTotal);
  });

  // ---------------------------------------------------------------------------
  // deleteBlock behavioral coverage. deleteBlock deletes the block's lines
  // first, then the block, then recomputes header totals — none of which was
  // exercised. This proves the block AND its lines disappear and the header
  // totals re-derive to zero from the (now empty) line set.
  // ---------------------------------------------------------------------------
  runDb('deleteBlock removes the block + its lines and recomputes totals to zero', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const block = await withDbAccessContext(fx.ctxA, () =>
      addBlock(quote.id, { blockType: 'line_items', content: { label: 'Pricing' } }, fx.actorA)
    );

    // Two lines inside the block: a one-time line (drives subtotal/oneTimeTotal)
    // and a monthly recurring line (drives monthlyRecurringTotal). Both must be
    // > 0 before delete so "→ zero" after delete is a meaningful assertion.
    const oneTime = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Setup fee', quantity: 2, unitPrice: 75,
        taxable: false, customerVisible: true, recurrence: 'one_time', blockId: block.id,
      }, fx.actorA)
    );
    const monthly = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Monthly support', quantity: 4, unitPrice: 25,
        taxable: false, customerVisible: true, recurrence: 'monthly', blockId: block.id,
      }, fx.actorA)
    );

    // Pre-delete sanity: totals are non-zero (proves the after-delete zero is real).
    const before = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(before.blocks.map((b) => b.id)).toContain(block.id);
    expect(before.lines).toHaveLength(2);
    expect(before.quote.oneTimeTotal).toBe('150.00'); // 2 * 75
    expect(before.quote.monthlyRecurringTotal).toBe('100.00'); // 4 * 25

    await withDbAccessContext(fx.ctxA, () => deleteBlock(quote.id, block.id, fx.actorA));

    const after = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    // Block gone.
    expect(after.blocks.map((b) => b.id)).not.toContain(block.id);
    expect(after.blocks).toHaveLength(0);
    // Lines gone (deleteBlock removes the block's lines explicitly, not orphaned
    // via block_id SET NULL): neither line id survives, and the set is empty.
    const afterLineIds = after.lines.map((l) => l.id);
    expect(afterLineIds).not.toContain(oneTime.id);
    expect(afterLineIds).not.toContain(monthly.id);
    expect(after.lines).toHaveLength(0);
    // Header totals re-derived from the empty line set → all zero.
    expect(after.quote.subtotal).toBe('0.00');
    expect(after.quote.oneTimeTotal).toBe('0.00');
    expect(after.quote.monthlyRecurringTotal).toBe('0.00');
    expect(after.quote.annualRecurringTotal).toBe('0.00');
  });

  runDb('deleteBlock on a non-draft quote throws NOT_A_DRAFT (409)', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const block = await withDbAccessContext(fx.ctxA, () =>
      addBlock(quote.id, { blockType: 'heading', content: { text: 'Scope', level: 2 } }, fx.actorA)
    );
    // Flip to 'sent' under system scope (same approach as the updateQuote-non-draft
    // test) so the draft-only guard in loadDraft is exercised.
    await withSystemDbAccessContext(() =>
      db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quote.id))
    );

    await expect(
      withDbAccessContext(fx.ctxA, () => deleteBlock(quote.id, block.id, fx.actorA))
    ).rejects.toMatchObject({ status: 409, code: 'NOT_A_DRAFT' });
  });

  // ---------------------------------------------------------------------------
  // Catalog subscription-field persistence + quote snapshot. Fix batch A wired
  // catalogService to persist billingFrequency/commitmentTermMonths; this locks
  // both the persistence (re-fetch via the real catalogService) AND that
  // addCatalogLine snapshots the recurrence/term onto the quote line and the
  // header annual bucket. Uses the real catalogService under a partner ctx.
  // ---------------------------------------------------------------------------
  runDb('catalogService persists billingFrequency/commitmentTermMonths and addCatalogLine snapshots them (annual)', async () => {
    const fx = await seedFixture();
    // A partner-A catalog actor (catalog is partner-axis; org access unrestricted
    // here, the same shape as the catalogService integration fixture).
    const catalogActorA: CatalogActor = {
      userId: null,
      partnerId: fx.partnerA.id,
      accessibleOrgIds: null,
    };

    const created = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'service',
          name: 'Annual managed suite',
          billingType: 'recurring',
          billingFrequency: 'annual',
          commitmentTermMonths: 12,
          unitPrice: 1200,
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        catalogActorA
      )
    );
    // The create return already reflects the persisted subscription fields.
    expect(created.billingFrequency).toBe('annual');
    expect(created.commitmentTermMonths).toBe(12);

    // Re-fetch via the real catalogService — proves the fields round-tripped to
    // the DB (NOT null), independent of the create return value.
    const refetched = await withDbAccessContext(fx.ctxA, () =>
      getCatalogItem(created.id, catalogActorA)
    );
    expect(refetched.item.billingFrequency).toBe('annual');
    expect(refetched.item.commitmentTermMonths).toBe(12);

    // Snapshot onto a draft quote line. addCatalogLine derives recurrence from
    // the item's annual billing frequency and snapshots termMonths/frequency.
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const line = await withDbAccessContext(fx.ctxA, () =>
      addCatalogLine(quote.id, created.id, 1, undefined, fx.actorA)
    );
    expect(line.recurrence).toBe('annual');
    expect(line.termMonths).toBe(12);
    expect(line.billingFrequency).toBe('annual');
    expect(line.unitPrice).toBe('1200.00');

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    // The annual line lands in the annual recurring bucket, not monthly/one-time.
    expect(fetched.quote.annualRecurringTotal).toBe('1200.00');
    expect(fetched.quote.monthlyRecurringTotal).toBe('0.00');
    expect(fetched.quote.oneTimeTotal).toBe('0.00');
  });

  runDb('catalogService persists monthly billingFrequency and addCatalogLine snapshots recurrence=monthly', async () => {
    const fx = await seedFixture();
    const catalogActorA: CatalogActor = {
      userId: null,
      partnerId: fx.partnerA.id,
      accessibleOrgIds: null,
    };

    const created = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'service',
          name: 'Monthly seat',
          billingType: 'recurring',
          billingFrequency: 'monthly',
          commitmentTermMonths: 6,
          unitPrice: 30,
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        catalogActorA
      )
    );
    const refetched = await withDbAccessContext(fx.ctxA, () =>
      getCatalogItem(created.id, catalogActorA)
    );
    expect(refetched.item.billingFrequency).toBe('monthly');
    expect(refetched.item.commitmentTermMonths).toBe(6);

    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const line = await withDbAccessContext(fx.ctxA, () =>
      addCatalogLine(quote.id, created.id, 2, undefined, fx.actorA)
    );
    expect(line.recurrence).toBe('monthly');
    expect(line.billingFrequency).toBe('monthly');
    expect(line.termMonths).toBe(6);

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    expect(fetched.quote.monthlyRecurringTotal).toBe('60.00'); // 2 * 30
    expect(fetched.quote.annualRecurringTotal).toBe('0.00');
  });
});
