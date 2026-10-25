/**
 * #9402 W1b — the customer-document assembler on real Postgres. The hidden-line
 * filter is SQL and the partner-axis reads depend on RLS, so a mocked DB proves
 * neither: this seeds an invoice with a hidden line, a partner with a
 * non-English document language and a portal_branding row, then assembles it
 * under the three caller contexts that use it — the logged-in portal user (org
 * scope, no partner access), a staff partner user, and the public link's
 * system context — asserting the hidden line is absent, the partner-axis reads
 * returned rows (not the silent zero rows of the #1375 class) and the document
 * locale is the partner's.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../db';
import { invoiceLines, invoices, organizations, partners, users } from '../db/schema';
import { portalBranding } from '../db/schema/portal';
import { assembleCustomerInvoiceDocument, CustomerDocumentModeError } from './customerDocument';
import { getOwnedInvoiceOr404, getPortalInvoiceRowOr404 } from './invoiceService';

const RUN = !!process.env.DATABASE_URL;
const HIDDEN = 'HIDDEN-LINE-SENTINEL';
const NOTE = 'TECH-NOTE-SENTINEL';

interface Fixture {
  partnerId: string; orgId: string; userId: string; issuedId: string; draftId: string;
  partnerName: string; billingEmail: string; logoUrl: string;
}

async function seed(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const partnerName = `CustDoc MSP ${suffix}`;
    const billingEmail = `billing-${suffix}@example.test`;
    const logoUrl = `https://cdn.example.test/${suffix}.png`;
    const [p] = await db.insert(partners).values({
      name: partnerName, slug: `custdoc-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      billingEmail, settings: { language: 'pt-BR' }, invoiceLineShowNote: false,
      invoiceLineGrouping: 'day', invoiceLineShowDate: true,
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `CustDoc Org ${suffix}`, slug: `custdoc-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    await db.insert(portalBranding).values({ orgId, logoUrl, primaryColor: '#1d4ed8' });

    // Issued, frozen with the note shown and no stamped locale (→ partner language).
    const [issued] = await db.insert(invoices).values({
      partnerId, orgId, status: 'sent', invoiceNumber: `INV-CD-${suffix.slice(0, 4)}`,
      currencyCode: 'USD', issueDate: '2026-03-01', dueDate: '2026-03-31',
      subtotal: '150.00', taxRate: '0', taxTotal: '0.00', total: '150.00', amountPaid: '0.00', balance: '150.00',
      lineGrouping: 'entry', lineShowDate: false, lineShowNote: true, lineShowWorkedTime: true,
      documentTheme: 'condensed', documentPageSize: 'a4',
    }).returning({ id: invoices.id });
    const issuedId = issued!.id;
    await db.insert(invoiceLines).values([
      { invoiceId: issuedId, orgId, sourceType: 'manual', name: 'Consulting', description: 'Network review', quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, lineTotal: '100.00', sortOrder: 0 },
      { invoiceId: issuedId, orgId, sourceType: 'manual', name: null, description: 'Support', quantity: '1', unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00', sortOrder: 1 },
      { invoiceId: issuedId, orgId, sourceType: 'manual', name: 'Internal adjustment', description: HIDDEN, quantity: '1', unitPrice: '0.00', taxable: false, customerVisible: false, lineTotal: '0.00', sortOrder: 2 },
    ]);

    // Draft with NULL line-detail columns: the partner default (note OFF) applies.
    const [draft] = await db.insert(invoices).values({
      partnerId, orgId, status: 'draft', currencyCode: 'USD',
      subtotal: '75.00', taxRate: '0', taxTotal: '0.00', total: '75.00', amountPaid: '0.00', balance: '75.00',
    }).returning({ id: invoices.id });
    const draftId = draft!.id;
    await db.insert(invoiceLines).values([
      { invoiceId: draftId, orgId, sourceType: 'time_entry', name: null, description: NOTE, quantity: '0.75', unitPrice: '100.00', taxable: false, customerVisible: true, lineTotal: '75.00', sortOrder: 0, workDate: '2026-02-26' },
      { invoiceId: draftId, orgId, sourceType: 'manual', name: 'Hidden draft line', description: HIDDEN, quantity: '1', unitPrice: '0.00', taxable: false, customerVisible: false, lineTotal: '0.00', sortOrder: 1 },
    ]);
    return { partnerId, orgId, userId: u!.id, issuedId, draftId, partnerName, billingEmail, logoUrl };
  });
}

/** The logged-in portal's context (routes/portal/auth.ts): org scope, no partner access. */
const portalCtx = (f: Fixture): DbAccessContext => ({
  scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null,
});
/** A staff partner user (the customer-view route's caller). */
const staffCtx = (f: Fixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});

function expectCustomerDocument(f: Fixture, doc: Awaited<ReturnType<typeof assembleCustomerInvoiceDocument>>) {
  expect(doc.lines).toHaveLength(2);
  expect(doc.lines.map((l) => l.name ?? l.description)).toEqual(['Consulting', 'Support']);
  expect(JSON.stringify(doc)).not.toContain(HIDDEN);
  // Partner-axis reads returned the partner row (not zero rows under RLS).
  expect(doc.branding.partnerName).toBe(f.partnerName);
  expect(doc.branding.contactEmail).toBe(f.billingEmail);
  // portal_branding row (read in its own system context, keyed on the invoice's org).
  expect(doc.branding.logoUrl).toBe(f.logoUrl);
  expect(doc.branding).toMatchObject({ theme: 'condensed', pageSize: 'a4' });
  expect(doc.documentLocale).toBe('pt-BR');
  expect(doc.invoice.displayStatus).toBe('sent');
}

describe.runIf(RUN)('customer-document assembler on Postgres (#9402)', () => {
  it('portal-user context: hidden line absent, partner-axis reads return rows, documentLocale = partner locale', async () => {
    const f = await seed();
    const doc = await withDbAccessContext(portalCtx(f), async () =>
      assembleCustomerInvoiceDocument(await getPortalInvoiceRowOr404(f.issuedId, f.orgId), 'portal'));
    expectCustomerDocument(f, doc);
  });

  it('portal-user context: a draft is refused by the assembler', async () => {
    const f = await seed();
    await expect(withDbAccessContext(portalCtx(f), async () =>
      assembleCustomerInvoiceDocument(await getPortalInvoiceRowOr404(f.draftId, f.orgId), 'portal')))
      .rejects.toBeInstanceOf(CustomerDocumentModeError);
  });

  it('staff context: same, and a draft assembles with partner defaults', async () => {
    const f = await seed();
    const doc = await withDbAccessContext(staffCtx(f), async () =>
      assembleCustomerInvoiceDocument(await getOwnedInvoiceOr404(f.issuedId), 'staff'));
    expectCustomerDocument(f, doc);

    const draft = await withDbAccessContext(staffCtx(f), async () =>
      assembleCustomerInvoiceDocument(await getOwnedInvoiceOr404(f.draftId), 'staff'));
    expect(draft.invoice.displayStatus).toBeNull();
    expect(draft.lines).toHaveLength(1);
    // partners.invoice_line_show_note = false → the time-entry note is withheld before projection.
    expect(draft.lines[0]).toMatchObject({ description: '' });
    expect(draft.lines[0]!.name).toBeTruthy();
    expect(JSON.stringify(draft)).not.toContain(NOTE);
    expect(JSON.stringify(draft)).not.toContain(HIDDEN);
    expect(draft.documentLocale).toBe('pt-BR');
    // The header groups the way the lines were projected: the partner default issuing will freeze.
    expect(draft.invoice.lineGrouping).toBe('day');
    expect(draft.lines[0]!.workDate).toBe('2026-02-26');
  });

  it('staff context of ANOTHER partner cannot load the row (RLS), so it never reaches the assembler', async () => {
    const f = await seed();
    const otherPartner: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: ['00000000-0000-4000-8000-00000000abcd'], userId: f.userId,
    };
    await expect(withDbAccessContext(otherPartner, () => getOwnedInvoiceOr404(f.issuedId)))
      .rejects.toMatchObject({ status: 404 });
  });

  it('system context (public route): same', async () => {
    const f = await seed();
    const doc = await withSystemDbAccessContext(async () =>
      assembleCustomerInvoiceDocument(await getOwnedInvoiceOr404(f.issuedId), 'public'));
    expectCustomerDocument(f, doc);
  });
});
