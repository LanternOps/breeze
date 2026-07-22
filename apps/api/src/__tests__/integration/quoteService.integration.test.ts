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
import { quotes, quoteLines, quoteBlocks } from '../../db/schema/quotes';
import { catalogItems } from '../../db/schema/catalog';
import { createOrganization, createPartner } from './db-utils';
import {
  createQuote,
  cloneQuote,
  getQuote,
  addBlock,
  deleteBlock,
  addManualLine,
  addCatalogLine,
  updateLine,
  removeLine,
  updateQuote,
  deleteDraftQuote,
  toCustomerLines,
  moveLineToBlock,
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
      costBasis: values.costBasis ?? null,
      sku: values.sku ?? null,
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
        depositEligible: false,
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

  runDb('addManualLine without a blockId lands in an auto-created pricing section, reused across lines (#2553)', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );

    const l1 = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'First', quantity: 1, unitPrice: 100,
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, fx.actorA)
    );
    // Never orphaned — the line carries a real blockId.
    expect(l1.blockId).toBeTruthy();

    const l2 = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Second', quantity: 1, unitPrice: 50,
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, fx.actorA)
    );

    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(quote.id, fx.actorA));
    // One default line_items section is created and REUSED for both lines, so the
    // editor (which renders lines only inside blocks) shows them — no ghost line.
    const lineBlocks = fetched.blocks.filter((b) => b.blockType === 'line_items');
    expect(lineBlocks).toHaveLength(1);
    expect(l1.blockId).toBe(lineBlocks[0]!.id);
    expect(l2.blockId).toBe(lineBlocks[0]!.id);
    expect(fetched.lines.every((l) => l.blockId === lineBlocks[0]!.id)).toBe(true);
  });

  /**
   * Forge the pre-#2553 orphan shape on an existing quote: null out every line's
   * block_id, and optionally delete the blocks so the quote has no pricing
   * section at all. Runs under system scope — the API can no longer create this
   * shape, but legacy rows (and prod quote 50a25127) still carry it.
   */
  async function orphanAllLines(quoteId: string, opts: { dropBlocks?: boolean } = {}) {
    await withSystemDbAccessContext(async () => {
      await db.update(quoteLines).set({ blockId: null }).where(eq(quoteLines.quoteId, quoteId));
      if (opts.dropBlocks) await db.delete(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId));
    });
  }

  runDb('cloneQuote lands legacy orphan lines in ONE real pricing section on the clone', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    for (const price of [100, 50]) {
      await withDbAccessContext(fx.ctxA, () =>
        addManualLine(quote.id, {
          sourceType: 'manual', description: `Line ${price}`, quantity: 1, unitPrice: price,
          taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
        }, fx.actorA)
      );
    }
    // Source has NO line_items block left, so the clone must mint one itself.
    await orphanAllLines(quote.id, { dropBlocks: true });

    const cloned = await withDbAccessContext(fx.ctxA, () => cloneQuote(quote.id, fx.actorA));
    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(cloned.id, fx.actorA));

    const lineBlocks = fetched.blocks.filter((b) => b.blockType === 'line_items');
    expect(lineBlocks).toHaveLength(1); // ONE fallback section, not one per orphan
    expect(fetched.lines).toHaveLength(2);
    // The orphan never propagates: every cloned line is editable in the builder.
    expect(fetched.lines.every((l) => l.blockId === lineBlocks[0]!.id)).toBe(true);

    // The SOURCE is left exactly as it was — cloning repairs the copy, not the original.
    const sourceLines = await withDbAccessContext(fx.ctxA, () =>
      db.select({ blockId: quoteLines.blockId }).from(quoteLines).where(eq(quoteLines.quoteId, quote.id))
    );
    expect(sourceLines.every((l) => l.blockId === null)).toBe(true);
  });

  runDb('cloneQuote re-parents an orphan onto the clone of the source pricing section', async () => {
    const fx = await seedFixture();
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Kept', quantity: 1, unitPrice: 100,
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, fx.actorA)
    );
    // Keep the auto-created line_items block; only orphan the line.
    await orphanAllLines(quote.id);

    const cloned = await withDbAccessContext(fx.ctxA, () => cloneQuote(quote.id, fx.actorA));
    const fetched = await withDbAccessContext(fx.ctxA, () => getQuote(cloned.id, fx.actorA));

    // No extra section is spawned — the existing one is reused.
    const lineBlocks = fetched.blocks.filter((b) => b.blockType === 'line_items');
    expect(lineBlocks).toHaveLength(1);
    expect(fetched.lines[0]!.blockId).toBe(lineBlocks[0]!.id);
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
    expect(line.name).toBe('Managed endpoint');
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
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
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
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
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
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, fx.actorA)
    );
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Monthly seat', quantity: 7, unitPrice: 12.50,
        taxable: false, customerVisible: true, recurrence: 'monthly', depositEligible: false,
      }, fx.actorA)
    );
    await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Internal cost (hidden)', quantity: 1, unitPrice: 999.99,
        taxable: false, customerVisible: false, recurrence: 'one_time', depositEligible: false,
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
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, blockId: block.id,
      }, fx.actorA)
    );
    const monthly = await withDbAccessContext(fx.ctxA, () =>
      addManualLine(quote.id, {
        sourceType: 'manual', description: 'Monthly support', quantity: 4, unitPrice: 25,
        taxable: false, customerVisible: true, recurrence: 'monthly', depositEligible: false, blockId: block.id,
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

  // --- Cross-partner catalog disclosure (T7) ------------------------------
  // catalog_items is partner-axis RLS. For a partner-scope caller RLS contains
  // a foreign item, but under SYSTEM scope the partner predicate short-circuits,
  // so a system-scope request could snapshot ANOTHER partner's catalog item into
  // a quote line (name/unitPrice/taxable/billingType disclosure + binding a
  // foreign catalog_item_id FK). addCatalogLine must therefore resolve the item
  // scoped to the quote's OWN partner — a foreign item must be not-found even
  // when RLS would otherwise let the read through.
  runDb('addCatalogLine rejects a catalog item owned by a different partner (system scope, no snapshot)', async () => {
    const fx = await seedFixture();
    // A second partner with its own catalog item (the "victim").
    const partnerB = await withSystemDbAccessContext(() => createPartner());
    const foreignItem = await seedCatalogItem(partnerB.id, {
      name: "Partner B's secret SKU",
      unitPrice: '999.99',
      billingType: 'recurring',
      billingFrequency: 'annual',
      commitmentTermMonths: 36,
      taxable: false,
    });
    // partner-A's draft quote.
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );

    // Run under SYSTEM scope (the attack vector): the catalog partner predicate
    // short-circuits, so without an explicit partner filter the foreign item
    // would resolve and be snapshotted. With the fix it must be not-found.
    await expect(
      withSystemDbAccessContext(() =>
        addCatalogLine(quote.id, foreignItem.id, 1, undefined, fx.actorA)
      )
    ).rejects.toMatchObject({ code: 'CATALOG_ITEM_NOT_FOUND', status: 404 });

    // No line was snapshotted, so no foreign data leaked onto the quote.
    const lines = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id))
    );
    expect(lines).toHaveLength(0);
  });

  runDb('addCatalogLine still works for a same-partner item under system scope', async () => {
    const fx = await seedFixture();
    const item = await seedCatalogItem(fx.partnerA.id, {
      name: 'Own SKU',
      unitPrice: '10.00',
      billingType: 'one_time',
      taxable: true,
    });
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const line = await withSystemDbAccessContext(() =>
      addCatalogLine(quote.id, item.id, 3, undefined, fx.actorA)
    );
    expect(line.catalogItemId).toBe(item.id);
    expect(line.unitPrice).toBe('10.00');
    expect(line.name).toBe('Own SKU');
    expect(line.lineTotal).toBe('30.00'); // 3 * 10.00
  });

  // ---------------------------------------------------------------------------
  // Task 5: cost/sku snapshot on add + no-leak serializer.
  // ---------------------------------------------------------------------------

  runDb('addCatalogLine snapshots unitCost and sku from the catalog item', async () => {
    const fx = await seedFixture();
    // Catalog item with a cost basis of 100.00 and a sell price of 130.00.
    const item = await seedCatalogItem(fx.partnerA.id, {
      name: 'Security Suite',
      unitPrice: '130.00',
      costBasis: '100.00',
      sku: 'SKU-1',
      billingType: 'one_time',
      taxable: true,
    });
    const quote = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA)
    );
    const line = await withDbAccessContext(fx.ctxA, () =>
      addCatalogLine(quote.id, item.id, 1, undefined, fx.actorA)
    );
    // Cost and SKU are snapshotted from the catalog item at add-time.
    expect(line.unitCost).toBe('100.00');
    expect(line.sku).toBe('SKU-1');
    // Sell price is unchanged.
    expect(line.unitPrice).toBe('130.00');
  });

  // No-DB required: toCustomerLines is a pure transformation — tests that the
  // public/portal serializer strips unitCost before returning data to the customer.
  it('toCustomerLines strips unitCost from the customer payload (never leaks unit_cost)', () => {
    const rawLine = {
      id: 'test-id',
      unitCost: '100.00',
      sku: 'SKU-1',
      partNumber: 'P-001',
      name: 'Security Suite',
      unitPrice: '130.00',
      lineTotal: '130.00',
    };
    const [stripped] = toCustomerLines([rawLine]);
    const json = JSON.stringify({ lines: [stripped] });
    expect(json).not.toContain('unit_cost');
    expect(json).not.toContain('unitCost');
    expect(stripped).not.toHaveProperty('unitCost');
    // sku and partNumber are acceptable on the customer document.
    expect(stripped).toHaveProperty('sku', 'SKU-1');
    expect(stripped).toHaveProperty('partNumber', 'P-001');
  });

  // ---- moveLineToBlock ------------------------------------------------------

  /** Seed a quote with two pricing blocks and three manual lines: A1, A2 in
   *  blockA; B1 in blockB. Returns everything the move tests need. */
  async function seedTwoPanelQuote(fx: Fixture) {
    return withDbAccessContext(fx.ctxA, async () => {
      const quote = await createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA);
      const blockA = await addBlock(quote.id, { blockType: 'line_items', content: {} }, fx.actorA);
      const blockB = await addBlock(quote.id, { blockType: 'line_items', content: {} }, fx.actorA);
      const mk = (name: string, blockId: string) =>
        addManualLine(quote.id, {
          sourceType: 'manual', name, description: null, quantity: 1, unitPrice: 10,
          taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, blockId,
        }, fx.actorA);
      const lineA1 = await mk('A1', blockA.id);
      const lineA2 = await mk('A2', blockA.id);
      const lineB1 = await mk('B1', blockB.id);
      return { quote, blockA, blockB, lineA1, lineA2, lineB1 };
    });
  }

  runDb('moveLineToBlock appends the line to the end of the target block', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);

    const moved = await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockB.id, fx.actorA)
    );
    expect(moved.blockId).toBe(s.blockB.id);
    expect(moved.sortOrder).toBeGreaterThan(s.lineB1.sortOrder);

    const rows = await withDbAccessContext(fx.ctxA, () =>
      db.select({ id: quoteLines.id, blockId: quoteLines.blockId, sortOrder: quoteLines.sortOrder })
        .from(quoteLines).where(eq(quoteLines.quoteId, s.quote.id))
    );
    const inB = rows.filter((r) => r.blockId === s.blockB.id).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(inB.map((r) => r.id)).toEqual([s.lineB1.id, s.lineA1.id]);
    const inA = rows.filter((r) => r.blockId === s.blockA.id);
    expect(inA.map((r) => r.id)).toEqual([s.lineA2.id]);
  });

  runDb('moveLineToBlock is a no-op success when the line is already in the target block', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const moved = await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockA.id, fx.actorA)
    );
    expect(moved.blockId).toBe(s.blockA.id);
    expect(moved.sortOrder).toBe(s.lineA1.sortOrder); // untouched
  });

  runDb('moveLineToBlock rejects a non-line_items target block', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const heading = await withDbAccessContext(fx.ctxA, () =>
      addBlock(s.quote.id, { blockType: 'heading', content: { text: 'Summary', level: 2 } }, fx.actorA)
    );
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, heading.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'BLOCK_NOT_LINE_ITEMS', status: 400 });
  });

  runDb('moveLineToBlock 404s when the target block belongs to another quote', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const other = await withDbAccessContext(fx.ctxA, async () => {
      const q2 = await createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA);
      return addBlock(q2.id, { blockType: 'line_items', content: {} }, fx.actorA);
    });
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, other.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND', status: 404 });
  });

  runDb('moveLineToBlock moves bundle children with their parent, in order', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    // Seed two bundle children under lineA1 directly (system scope bypasses RLS
    // for the seed, matching the sibling seed helpers in this file).
    const [c1, c2] = await withSystemDbAccessContext(async () => {
      const mkChild = async (name: string, sortOrder: number) => {
        const [row] = await db.insert(quoteLines).values({
          quoteId: s.quote.id, orgId: fx.orgA.id, blockId: s.blockA.id,
          sourceType: 'bundle', parentLineId: s.lineA1.id, name,
          quantity: '1.00', unitPrice: '5.00', lineTotal: '5.00',
          taxable: false, customerVisible: true, recurrence: 'one_time', sortOrder,
        }).returning();
        return row!;
      };
      return [await mkChild('child-1', 10), await mkChild('child-2', 11)];
    });

    await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockB.id, fx.actorA)
    );
    const rows = await withDbAccessContext(fx.ctxA, () =>
      db.select({ id: quoteLines.id, blockId: quoteLines.blockId, sortOrder: quoteLines.sortOrder })
        .from(quoteLines).where(eq(quoteLines.quoteId, s.quote.id))
    );
    const inB = rows.filter((r) => r.blockId === s.blockB.id).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(inB.map((r) => r.id)).toEqual([s.lineB1.id, s.lineA1.id, c1.id, c2.id]);
  });

  runDb('moveLineToBlock rejects moving a bundle child directly', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const child = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(quoteLines).values({
        quoteId: s.quote.id, orgId: fx.orgA.id, blockId: s.blockA.id,
        sourceType: 'bundle', parentLineId: s.lineA1.id, name: 'child',
        quantity: '1.00', unitPrice: '5.00', lineTotal: '5.00',
        taxable: false, customerVisible: true, recurrence: 'one_time', sortOrder: 10,
      }).returning();
      return row!;
    });
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, child.id, s.blockB.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'LINE_IS_BUNDLE_CHILD', status: 400 });
  });

  runDb('moveLineToBlock refuses to reshape a non-draft quote (NOT_A_DRAFT)', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    // Flip to 'sent' under system scope (as the sibling draft-guard tests do) so a
    // tech cannot silently reshape a quote a customer has already received.
    await withSystemDbAccessContext(() =>
      db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, s.quote.id))
    );
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockB.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  runDb('moveLineToBlock 404s for a lineId that is not on this quote (LINE_NOT_FOUND)', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    // A line that lives on a DIFFERENT quote must not be movable into this one —
    // the (lineId, quoteId) scoping is the tenant-safety check.
    const foreignLine = await withDbAccessContext(fx.ctxA, async () => {
      const q2 = await createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA);
      const b2 = await addBlock(q2.id, { blockType: 'line_items', content: {} }, fx.actorA);
      return addManualLine(q2.id, {
        sourceType: 'manual', name: 'foreign', description: null, quantity: 1, unitPrice: 10,
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, blockId: b2.id,
      }, fx.actorA);
    });
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, foreignLine.id, s.blockB.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'LINE_NOT_FOUND', status: 404 });
  });

  runDb('moveLineToBlock into an EMPTY target block starts sort order at 0', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    // Exercises the COALESCE(MAX(sort_order), -1)+1 base-0 path — every other move
    // test seeds the target with an existing line, so base is always >= 1.
    const emptyBlock = await withDbAccessContext(fx.ctxA, () =>
      addBlock(s.quote.id, { blockType: 'line_items', content: {} }, fx.actorA)
    );
    const moved = await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, emptyBlock.id, fx.actorA)
    );
    expect(moved.blockId).toBe(emptyBlock.id);
    expect(moved.sortOrder).toBe(0);
  });
});
