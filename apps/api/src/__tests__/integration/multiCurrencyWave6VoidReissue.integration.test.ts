/**
 * Wave-6 release gate, slice G5 (#3778): VOID / REISSUE against a non-USD org
 * on a USD partner, with the org's currency AND the partner's document language
 * changed between the original issue and the void.
 *
 * Multi-currency rules under test (spec §5, §12):
 *  - the reissue clone inherits the ORIGINAL invoice's header currency, never
 *    the org's current setting — no restamp, no conversion;
 *  - source rows are released back to `not_billed` and keep their OWN currency
 *    snapshots (the release is a billing-status flip, not a re-pricing);
 *  - lines are copied byte-for-byte (quantity / unit_price / line_total /
 *    source_id) with the bundle parent/child hierarchy remapped to the CLONED
 *    parent, never the original;
 *  - `document_locale` is an issue-time snapshot: the original keeps its stamp,
 *    the clone starts NULL, and issuing the replacement stamps the THEN-current
 *    partner locale.
 *
 * Coverage restoration (plan Task 6 Step 2): the source-release and
 * byte-identical-clone assertions previously existed only in
 * `apps/api/src/services/invoiceService.issue.integration.test.ts`, which ran in
 * NO CI job until Task 1 registered it. They are duplicated here so the coverage
 * survives regardless of that file's fate.
 *
 * Runs under vitest.integration.config.ts against a real Postgres. No fixture
 * memoization — integration/setup.ts TRUNCATEs partners/organizations before
 * every test, so each test re-seeds fresh.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ side effects are not the correctness under test (same
// rationale as the other wave-6 gate slices). Everything monetary runs for real.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/catalogEvents', () => ({ emitCatalogEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', () => ({ emitTicketEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { roundToCurrency } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { invoiceLines, invoices, organizations, partners, ticketParts, timeEntries } from '../../db/schema';
import { createCatalogItem, setBundleComponents } from '../../services/catalogService';
import { addBundleLine, assembleDraftFromOrg, issueInvoice, voidInvoice } from '../../services/invoiceService';
import { addTicketPart, createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { upsertOrgTicketSettings } from '../../services/ticketConfigService';
import { createTicket } from '../../services/ticketService';
import { gateLabel, seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

const dayOffset = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600000);

function assertionMessage(
  transition: string, currency: string, column: string, expected: unknown, actual: unknown,
): string {
  return `${transition}; currency=${currency}; column=${column}; expected=${String(expected)}; actual=${String(actual)}`;
}

/** numeric(x,2) round-trips as a scaled string; compare VALUE and additionally
 *  assert the persisted figure is representable at the currency's minor unit. */
function expectMoney(actual: string | null | undefined, expected: string | number, currency: string, ctx: string): void {
  const want = roundToCurrency(expected, currency);
  expect(Number(actual), assertionMessage(ctx, currency, 'amount', want, actual)).toBe(Number(want));
  expect(
    Number(roundToCurrency(Number(actual), currency)),
    assertionMessage(ctx, currency, 'minor-unit representability', `representable in ${currency}`, actual),
  ).toBe(Number(actual));
}

function timeActor(fixture: GateOrgFixture): TimeEntryActor {
  return {
    userId: fixture.userId,
    name: 'Gate Technician',
    partnerId: fixture.partnerId,
    manageAll: true,
    accessibleOrgIds: [fixture.orgId],
  };
}

function catalogActor(fixture: GateOrgFixture) {
  return { userId: fixture.userId, partnerId: fixture.partnerId, accessibleOrgIds: null };
}

async function readInvoice(id: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      id: invoices.id,
      status: invoices.status,
      currencyCode: invoices.currencyCode,
      documentLocale: invoices.documentLocale,
      replacesInvoiceId: invoices.replacesInvoiceId,
      replacedByInvoiceId: invoices.replacedByInvoiceId,
      voidedAt: invoices.voidedAt,
      voidReason: invoices.voidReason,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(invoices).where(eq(invoices.id, id)).limit(1));
  return row;
}

async function readLines(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      id: invoiceLines.id,
      sourceType: invoiceLines.sourceType,
      sourceId: invoiceLines.sourceId,
      catalogItemId: invoiceLines.catalogItemId,
      parentLineId: invoiceLines.parentLineId,
      name: invoiceLines.name,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      lineTotal: invoiceLines.lineTotal,
      taxable: invoiceLines.taxable,
      customerVisible: invoiceLines.customerVisible,
      sortOrder: invoiceLines.sortOrder,
    })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder, invoiceLines.name));
}

/** Comparable identity of a line, excluding its own id and the parent pointer
 *  (which is remapped by design and asserted separately). */
function lineShape(l: Awaited<ReturnType<typeof readLines>>[number]) {
  return {
    sourceType: l.sourceType, sourceId: l.sourceId, catalogItemId: l.catalogItemId, name: l.name,
    quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal,
    taxable: l.taxable, customerVisible: l.customerVisible, sortOrder: l.sortOrder,
  };
}

describe.runIf(RUN)(gateLabel('G5', 'void / reissue'), () => {
  it('reissue clones the ORIGINAL EUR document after the org flipped to GBP and the partner language changed', async () => {
    // --- Seed: USD partner (language de-DE) + EUR org -----------------------
    const fixture = await seedGateOrg('EUR', { partnerCurrency: 'USD', partnerLanguage: 'de-DE' });
    await withSystemDbAccessContext(() => upsertOrgTicketSettings(
      fixture.orgId, { defaultHourlyRate: 85.5, defaultBillable: true },
    ));
    const ticket = await withSystemDbAccessContext(() => createTicket(
      { orgId: fixture.orgId, subject: 'W6 G5 EUR void/reissue', source: 'manual' },
      { userId: fixture.userId, name: 'Gate Technician' },
    ));
    const ticketId = ticket.id as string;

    // Source-backed billables, both stamped EUR at creation.
    const entry = await withSystemDbAccessContext(() => createTimeEntry(
      { ticketId, startedAt: HOURS_AGO(3), endedAt: HOURS_AGO(1.5) },
      timeActor(fixture),
    ));
    const part = await withSystemDbAccessContext(() => addTicketPart(
      ticketId, { description: 'Replacement SSD', quantity: 3, unitPrice: 12.34 }, timeActor(fixture),
    ));

    // --- Bundle with children, priced in EUR --------------------------------
    const mkItem = (name: string, isBundle: boolean, eurPrice: number) => withSystemDbAccessContext(() =>
      createCatalogItem({
        itemType: 'service', name, billingType: 'one_time',
        prices: [{ currencyCode: 'USD', unitPrice: eurPrice }, { currencyCode: 'EUR', unitPrice: eurPrice }],
        unitOfMeasure: 'each', taxable: true, isBundle, attributes: {},
      }, catalogActor(fixture)));
    const bundle = await mkItem('G5 Onboarding bundle', true, 500);
    const compA = await mkItem('G5 Component A', false, 300);
    const compB = await mkItem('G5 Component B', false, 200);
    await withSystemDbAccessContext(() => setBundleComponents(bundle.id, [
      { componentItemId: compA.id, quantity: 1, showOnInvoice: true },
      { componentItemId: compB.id, quantity: 1, showOnInvoice: true },
    ], catalogActor(fixture)));

    // --- Assemble the EUR draft, add the bundle, issue ----------------------
    const assembled = await withSystemDbAccessContext(() => assembleDraftFromOrg(
      { orgId: fixture.orgId, from: dayOffset(-1), to: dayOffset(1) }, fixture.actor,
    ));
    expect(
      assembled.invoice.currencyCode,
      assertionMessage('assembleDraftFromOrg', 'EUR', 'invoices.currency_code', 'EUR', assembled.invoice.currencyCode),
    ).toBe('EUR');
    expect(assembled.blockedByCurrency, 'assembly must not block a same-currency org').toEqual([]);

    await withSystemDbAccessContext(() => addBundleLine(assembled.invoice.id, bundle.id, 1, fixture.actor));
    await withSystemDbAccessContext(() => issueInvoice(assembled.invoice.id, fixture.actor));

    const originalId = assembled.invoice.id;
    const issuedOriginal = await readInvoice(originalId);
    expect(
      issuedOriginal?.documentLocale,
      assertionMessage('issueInvoice (original)', 'EUR', 'invoices.document_locale', 'de-DE', issuedOriginal?.documentLocale),
    ).toBe('de-DE');
    const originalLines = await readLines(originalId);

    // --- Flip the org currency AND the partner document language ------------
    // Nothing already stamped may move as a result (spec §5: future-only).
    await withSystemDbAccessContext(async () => {
      await db.update(organizations).set({ currencyCode: 'GBP' }).where(eq(organizations.id, fixture.orgId));
      await db.update(partners).set({ settings: { language: 'fr-FR' } }).where(eq(partners.id, fixture.partnerId));
    });

    // --- Void with reissue --------------------------------------------------
    const reissued = await withSystemDbAccessContext(() => voidInvoice(
      originalId, 'wrong amounts', { reissue: true }, fixture.actor,
    ));
    const draftId = reissued.invoice.id;

    // (1) the original is void, still EUR, and keeps its original document_locale.
    const voided = await readInvoice(originalId);
    expect(voided?.status, assertionMessage('voidInvoice', 'EUR', 'invoices.status', 'void', voided?.status)).toBe('void');
    expect(
      voided?.currencyCode,
      assertionMessage('voidInvoice', 'EUR', 'invoices.currency_code (original, org now GBP)', 'EUR', voided?.currencyCode),
    ).toBe('EUR');
    expect(
      voided?.documentLocale,
      assertionMessage('voidInvoice', 'EUR', 'invoices.document_locale (original, partner now fr-FR)', 'de-DE', voided?.documentLocale),
    ).toBe('de-DE');
    expect(voided?.voidedAt, 'voided_at must be stamped').not.toBeNull();
    expect(voided?.invoiceNumber, 'a voided invoice keeps its number').toBe(issuedOriginal?.invoiceNumber);

    // (2) source rows released back to not_billed, currency snapshots untouched.
    const [entryRow] = await withSystemDbAccessContext(() => db
      .select({ billingStatus: timeEntries.billingStatus, currencyCode: timeEntries.currencyCode, hourlyRate: timeEntries.hourlyRate })
      .from(timeEntries).where(eq(timeEntries.id, entry.id)).limit(1));
    expect(
      entryRow?.billingStatus,
      assertionMessage('voidInvoice release', 'EUR', 'time_entries.billing_status', 'not_billed', entryRow?.billingStatus),
    ).toBe('not_billed');
    expect(
      entryRow?.currencyCode,
      assertionMessage('voidInvoice release', 'EUR', 'time_entries.currency_code (org now GBP)', 'EUR', entryRow?.currencyCode),
    ).toBe('EUR');
    expectMoney(entryRow?.hourlyRate, 85.5, 'EUR', 'released time entry keeps its EUR rate snapshot');

    const [partRow] = await withSystemDbAccessContext(() => db
      .select({ billingStatus: ticketParts.billingStatus, currencyCode: ticketParts.currencyCode, unitPrice: ticketParts.unitPrice })
      .from(ticketParts).where(eq(ticketParts.id, part.id)).limit(1));
    expect(
      partRow?.billingStatus,
      assertionMessage('voidInvoice release', 'EUR', 'ticket_parts.billing_status', 'not_billed', partRow?.billingStatus),
    ).toBe('not_billed');
    expect(
      partRow?.currencyCode,
      assertionMessage('voidInvoice release', 'EUR', 'ticket_parts.currency_code (org now GBP)', 'EUR', partRow?.currencyCode),
    ).toBe('EUR');
    expectMoney(partRow?.unitPrice, 12.34, 'EUR', 'released part keeps its EUR unit price snapshot');

    // (3) replacement links populated in BOTH directions.
    const draft = await readInvoice(draftId);
    expect(
      draft?.replacesInvoiceId,
      assertionMessage('voidInvoice reissue', 'EUR', 'invoices.replaces_invoice_id', originalId, draft?.replacesInvoiceId),
    ).toBe(originalId);
    expect(
      voided?.replacedByInvoiceId,
      assertionMessage('voidInvoice reissue', 'EUR', 'invoices.replaced_by_invoice_id', draftId, voided?.replacedByInvoiceId),
    ).toBe(draftId);

    // (4) the new draft is EUR — NOT the org's current GBP.
    expect(draft?.status, assertionMessage('voidInvoice reissue', 'EUR', 'invoices.status', 'draft', draft?.status)).toBe('draft');
    expect(
      draft?.currencyCode,
      assertionMessage('voidInvoice reissue', 'EUR', 'invoices.currency_code (clone, org now GBP)', 'EUR', draft?.currencyCode),
    ).toBe('EUR');

    // (5) cloned lines are byte-identical and the bundle hierarchy is remapped
    //     onto the CLONED parent (never the original's line id).
    const clonedLines = await readLines(draftId);
    expect(
      clonedLines.map(lineShape),
      assertionMessage('voidInvoice reissue', 'EUR', 'invoice_lines (clone vs original)', 'byte-identical', 'differs'),
    ).toEqual(originalLines.map(lineShape));

    const originalIds = new Set(originalLines.map((l) => l.id));
    const clonedParents = clonedLines.filter((l) => l.parentLineId === null);
    const clonedChildren = clonedLines.filter((l) => l.parentLineId !== null);
    expect(clonedChildren.length, 'the bundle contributed two child lines').toBe(2);
    const clonedBundleParent = clonedParents.find((l) => l.sourceType === 'bundle');
    expect(clonedBundleParent, 'the cloned draft must carry the bundle parent line').toBeTruthy();
    for (const child of clonedChildren) {
      expect(
        originalIds.has(child.parentLineId!),
        assertionMessage('voidInvoice reissue', 'EUR', 'invoice_lines.parent_line_id', 'points at a CLONED parent', child.parentLineId),
      ).toBe(false);
      expect(child.parentLineId).toBe(clonedBundleParent!.id);
    }
    // Source-backed lines keep their source_id so the released rows re-bill.
    expect(clonedLines.some((l) => l.sourceType === 'time_entry' && l.sourceId === entry.id)).toBe(true);
    expect(clonedLines.some((l) => l.sourceType === 'part' && l.sourceId === part.id)).toBe(true);

    // (6) the clone's document_locale is NULL — an issue-time snapshot is never copied.
    expect(
      draft?.documentLocale,
      assertionMessage('voidInvoice reissue', 'EUR', 'invoices.document_locale (clone)', null, draft?.documentLocale),
    ).toBeNull();

    // (7) issuing the replacement stamps the THEN-current locale and re-flips
    //     the released sources to billed — still in EUR, never the org's GBP.
    await withSystemDbAccessContext(() => issueInvoice(draftId, fixture.actor));
    const issuedReplacement = await readInvoice(draftId);
    expect(
      issuedReplacement?.status,
      assertionMessage('issueInvoice (replacement)', 'EUR', 'invoices.status', 'sent', issuedReplacement?.status),
    ).toBe('sent');
    expect(
      issuedReplacement?.currencyCode,
      assertionMessage('issueInvoice (replacement)', 'EUR', 'invoices.currency_code', 'EUR', issuedReplacement?.currencyCode),
    ).toBe('EUR');
    expect(
      issuedReplacement?.documentLocale,
      assertionMessage('issueInvoice (replacement)', 'EUR', 'invoices.document_locale', 'fr-FR', issuedReplacement?.documentLocale),
    ).toBe('fr-FR');

    const [entryAfter] = await withSystemDbAccessContext(() => db
      .select({ billingStatus: timeEntries.billingStatus, currencyCode: timeEntries.currencyCode })
      .from(timeEntries).where(eq(timeEntries.id, entry.id)).limit(1));
    expect(
      entryAfter?.billingStatus,
      assertionMessage('issueInvoice (replacement) source flip', 'EUR', 'time_entries.billing_status', 'billed', entryAfter?.billingStatus),
    ).toBe('billed');
    expect(entryAfter?.currencyCode, 'a re-billed source row is still never restamped').toBe('EUR');
    const [partAfter] = await withSystemDbAccessContext(() => db
      .select({ billingStatus: ticketParts.billingStatus, currencyCode: ticketParts.currencyCode })
      .from(ticketParts).where(eq(ticketParts.id, part.id)).limit(1));
    expect(
      partAfter?.billingStatus,
      assertionMessage('issueInvoice (replacement) source flip', 'EUR', 'ticket_parts.billing_status', 'billed', partAfter?.billingStatus),
    ).toBe('billed');
    expect(partAfter?.currencyCode, 'a re-billed source row is still never restamped').toBe('EUR');
  });
});
