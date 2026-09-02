import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test. Mocked so void/reissue doesn't open a BullMQ
// socket to the test Redis (same rationale as invoiceService.issue.integration).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, timeEntries, invoices, invoiceLines } from '../../db/schema';
import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
}

/**
 * Seed a USD partner with a EUR org (mixed currencies on purpose: every
 * assertion below is that the ORG's currency wins over the partner's) plus
 * one billable time entry for the assembly path.
 */
async function seedFixture(orgCurrency = 'EUR'): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Cur ${suffix}`, slug: `cur-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `cur-org-${suffix}`, currencyCode: orgCurrency
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    const userId = u!.id;
    const now = new Date();
    await db.insert(timeEntries).values({
      partnerId, orgId, userId, startedAt: now, endedAt: now,
      durationMinutes: 60, description: 'Work', isBillable: true,
      hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: true,
      currencyCode: orgCurrency
    });
    return { partnerId, orgId, userId };
  });
}

function actor(f: Fixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

const dayBefore = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const dayAfter = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

describe.runIf(RUN)('invoice currency stamping (spec §5)', () => {
  it('createManualInvoice stamps the org currency, not the partner currency', async () => {
    const f = await seedFixture();
    const inv = await withDbAccessContext(ctx(f), () =>
      svc.createManualInvoice({ orgId: f.orgId }, actor(f)));
    expect(inv.status).toBe('draft');
    expect(inv.currencyCode).toBe('EUR');
  });

  it('assembleDraftFromOrg stamps the org currency on the assembled draft', async () => {
    const f = await seedFixture();
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    expect(invoice.status).toBe('draft');
    expect(invoice.currencyCode).toBe('EUR');
  });

  it('void-and-reissue clones the ORIGINAL invoice currency, not the org current one', async () => {
    const f = await seedFixture();
    // Forge an issued EUR invoice with a manual line (no source rows to release).
    const issuedId = await withSystemDbAccessContext(async () => {
      const [inv] = await db.insert(invoices).values({
        partnerId: f.partnerId, orgId: f.orgId, status: 'sent', currencyCode: 'EUR',
        invoiceNumber: `INV-CUR-${Math.random().toString(36).slice(2, 8)}`,
        subtotal: '100.00', total: '100.00', balance: '100.00',
        issueDate: dayBefore(), dueDate: dayAfter()
      }).returning({ id: invoices.id });
      await db.insert(invoiceLines).values({
        invoiceId: inv!.id, orgId: f.orgId, sourceType: 'manual', sourceId: null,
        catalogItemId: null, parentLineId: null, ticketId: null, description: 'Service',
        quantity: '1', unitPrice: '100.00', costBasis: null, taxable: false,
        customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1
      });
      // Flip the ORG's currency after issuance: the reissued clone must copy
      // the document's stamp (EUR), never re-read the org's current setting.
      await db.update(organizations).set({ currencyCode: 'GBP' }).where(eq(organizations.id, f.orgId));
      return inv!.id;
    });

    const result = await withDbAccessContext(ctx(f), () =>
      svc.voidInvoice(issuedId, 'wrong amounts', { reissue: true }, actor(f)));
    expect(result.invoice.status).toBe('draft');
    expect(result.invoice.replacesInvoiceId).toBe(issuedId);
    expect(result.invoice.currencyCode).toBe('EUR');
  });
});

describe.runIf(RUN)('issueInvoice keeps the stamped header currency (B1)', () => {
  it('issues an EUR draft under a USD partner without overwriting the header currency', async () => {
    const f = await seedFixture(); // USD partner, EUR org
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    expect(invoice.currencyCode).toBe('EUR');

    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));
    expect(issued.status).toBe('sent');
    // B1: the issue UPDATE must not restamp from the partner ('USD').
    expect(issued.currencyCode).toBe('EUR');
    // Totals are 2-decimal EUR-rounded (1h @ 100.00, non-taxable labor) and
    // agree with the header currency.
    expect(issued.subtotal).toBe('100.00');
    expect(issued.total).toBe('100.00');
    expect(issued.balance).toBe('100.00');
  });

  it('JPY draft: header-currency rounding drives the persisted total (3.5 × 333 → 1166)', async () => {
    const f = await seedFixture('JPY'); // USD partner, JPY org
    const inv = await withDbAccessContext(ctx(f), () =>
      svc.createManualInvoice({ orgId: f.orgId }, actor(f)));
    expect(inv.currencyCode).toBe('JPY');
    // The unit price itself must be representable in the header currency — a
    // fractional yen is refused at the write seam since wave 6 (W6-G1-1), so
    // the rounding this case exercises comes from the QUANTITY, not from an
    // unrepresentable price.
    await expect(withDbAccessContext(ctx(f), () =>
      svc.addManualLine(inv.id, { description: 'Consulting', quantity: 3, unitPrice: 333.33, taxable: false }, actor(f))
    )).rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });

    await withDbAccessContext(ctx(f), () =>
      svc.addManualLine(inv.id, { description: 'Consulting', quantity: 3.5, unitPrice: 333, taxable: false }, actor(f)));

    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(inv.id, actor(f)));
    expect(issued.currencyCode).toBe('JPY');
    // 3.5 × 333 = 1165.5 rounds to a WHOLE-unit JPY total, not the USD-cent
    // 1165.50 the partner currency would have produced.
    expect(issued.total).toBe('1166.00');
    expect(issued.subtotal).toBe('1166.00');
    expect(issued.balance).toBe('1166.00');
  });
});
