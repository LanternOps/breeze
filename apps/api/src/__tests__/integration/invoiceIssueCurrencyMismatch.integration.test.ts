import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test. Mocked so issue doesn't open a BullMQ socket to
// the test Redis (same rationale as invoiceService.issue.integration).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, tickets, timeEntries, ticketParts, invoices, invoiceLines } from '../../db/schema';
import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  ticketId: string;
  entryId: string;
}

/**
 * USD partner, EUR org, one ticket with one `not_billed` EUR time entry. Every
 * snapshot below is stamped EUR; the mismatch cases forge a USD header over
 * those EUR rows to prove issueInvoice asserts source-vs-header under lock.
 */
async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Iss ${suffix}`, slug: `iss-${suffix}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `iss-org-${suffix}`, currencyCode: 'EUR'
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    const userId = u!.id;
    const [t] = await db.insert(tickets).values({
      orgId, partnerId, ticketNumber: `ISS-${suffix}`, subject: `Issue ${suffix}`, source: 'manual'
    }).returning({ id: tickets.id });
    const ticketId = t!.id;
    const now = new Date();
    const [te] = await db.insert(timeEntries).values({
      partnerId, orgId, userId, ticketId, startedAt: now, endedAt: now,
      durationMinutes: 60, description: 'Work', isBillable: true,
      hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: true, currencyCode: 'EUR'
    }).returning({ id: timeEntries.id });
    return { partnerId, orgId, userId, ticketId, entryId: te!.id };
  });
}

async function addEurPart(f: Fixture): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [part] = await db.insert(ticketParts).values({
      ticketId: f.ticketId, orgId: f.orgId, description: 'SSD', quantity: '1.00', unitPrice: '80.00',
      currencyCode: 'EUR', isBillable: true, billingStatus: 'not_billed', addedBy: f.userId
    }).returning({ id: ticketParts.id });
    return part!.id;
  });
}

/** Forge a draft in `currencyCode` with one customer-visible line per source. */
async function forgeDraft(
  f: Fixture, currencyCode: string,
  sources: Array<{ sourceType: 'time_entry' | 'part'; sourceId: string }>
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [draft] = await db.insert(invoices).values({
      partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values(sources.map((s, i) => ({
      invoiceId: draft!.id, orgId: f.orgId, sourceType: s.sourceType, sourceId: s.sourceId,
      catalogItemId: null, parentLineId: null, ticketId: f.ticketId, description: 'Work',
      quantity: '1.00', unitPrice: '100.00', costBasis: null, taxable: false,
      customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: i
    })));
    return draft!.id;
  });
}

function actor(f: Fixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

async function readInvoice(id: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: invoices.status, invoiceNumber: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, id)));
  return row!;
}
async function entryStatus(id: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ s: timeEntries.billingStatus }).from(timeEntries).where(eq(timeEntries.id, id)));
  return row!.s;
}
async function partStatus(id: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ s: ticketParts.billingStatus }).from(ticketParts).where(eq(ticketParts.id, id)));
  return row!.s;
}

describe.runIf(RUN)('issueInvoice asserts time/part source currency under lock (wave 4, #3776)', () => {
  it('rejects a USD draft whose time-entry source is snapshotted in EUR, leaving both rows untouched', async () => {
    const f = await seedFixture();
    const draftId = await forgeDraft(f, 'USD', [{ sourceType: 'time_entry', sourceId: f.entryId }]);

    await expect(withDbAccessContext(ctx(f), () => svc.issueInvoice(draftId, actor(f))))
      .rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });

    expect(await entryStatus(f.entryId)).toBe('not_billed');
    expect(await readInvoice(draftId)).toEqual({ status: 'draft', invoiceNumber: null });
  });

  it('rejects a USD draft whose part source is snapshotted in EUR, leaving both rows untouched', async () => {
    const f = await seedFixture();
    const partId = await addEurPart(f);
    const draftId = await forgeDraft(f, 'USD', [{ sourceType: 'part', sourceId: partId }]);

    await expect(withDbAccessContext(ctx(f), () => svc.issueInvoice(draftId, actor(f))))
      .rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });

    expect(await partStatus(partId)).toBe('not_billed');
    expect(await readInvoice(draftId)).toEqual({ status: 'draft', invoiceNumber: null });
  });

  it('names the offending currency and the header currency in the error', async () => {
    const f = await seedFixture();
    const draftId = await forgeDraft(f, 'USD', [{ sourceType: 'time_entry', sourceId: f.entryId }]);
    await expect(withDbAccessContext(ctx(f), () => svc.issueInvoice(draftId, actor(f))))
      .rejects.toThrow(/Time entries are in EUR; this invoice is in USD/);
  });

  it('issues a EUR draft assembled from the ticket and flips the EUR entry + part to billed', async () => {
    const f = await seedFixture();
    const partId = await addEurPart(f);
    const { invoice } = await withDbAccessContext(ctx(f), () => svc.assembleDraftFromTicket(f.ticketId, actor(f)));
    expect(invoice.currencyCode).toBe('EUR');

    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));
    expect(issued.status).toBe('sent');
    expect(issued.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
    expect(await entryStatus(f.entryId)).toBe('billed');
    expect(await partStatus(partId)).toBe('billed');
  });
});
