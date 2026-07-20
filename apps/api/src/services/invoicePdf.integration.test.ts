import { describe, it, expect, vi } from 'vitest';

// Same rationale as invoiceService.issue.integration.test.ts: events are
// fire-and-forget BullMQ side effects; mock the emitter so these DB-correctness
// tests don't open a socket to the unauthenticated test Redis and hang.
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

// sendInvoiceEmail issues a draft, which enqueues an async PDF render. Stub it so
// the issue path doesn't open a BullMQ socket to the test Redis (covered elsewhere).
vi.mock('../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

// Force the "email not configured" branch deterministically (rather than relying
// on the test env lacking SMTP config) so the emailed:false assertion is honest.
vi.mock('./email', () => ({ getEmailService: () => null, buildInvoiceTemplate: vi.fn() }));

import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations, invoices, invoiceLines, invoiceDocuments } from '../db/schema';
import { eq } from 'drizzle-orm';
import { renderInvoicePdf, getInvoicePdf, sendInvoiceEmail } from './invoicePdf';
import { getCustomerInvoice, markViewed } from './invoiceService';
import { InvoiceServiceError } from './invoiceTypes';
import type { InvoiceActor } from './invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

interface Fixture { partnerId: string; orgId: string; invoiceId: string; }

async function seedIssuedInvoice(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Pdf ${suffix}`, slug: `pdf-${suffix}`, type: 'msp', plan: 'pro', status: 'active'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Pdf Org ${suffix}`, slug: `pdf-org-${suffix}`,
      billingAddressLine1: '500 Test Ave', billingAddressCity: 'Testville', billingAddressRegion: 'CA',
      billingAddressPostalCode: '90001', billingAddressCountry: 'US'
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [inv] = await db.insert(invoices).values({
      partnerId, orgId, status: 'sent', invoiceNumber: `INV-2026-${suffix.slice(0, 4)}`,
      currencyCode: 'USD', issueDate: '2026-06-14', dueDate: '2026-07-14',
      subtotal: '150.00', taxRate: '0.085', taxTotal: '8.50', total: '158.50',
      amountPaid: '0.00', balance: '158.50', billToName: `Pdf Org ${suffix}`,
      billToAddress: { line1: '500 Test Ave', city: 'Testville', region: 'CA', postalCode: '90001', country: 'US' }
    }).returning({ id: invoices.id });
    const invoiceId = inv!.id;
    await db.insert(invoiceLines).values([
      { invoiceId, orgId, sourceType: 'manual', description: 'Consulting', quantity: '1', unitPrice: '100.00', taxable: true, customerVisible: true, lineTotal: '100.00', sortOrder: 0 },
      { invoiceId, orgId, sourceType: 'manual', description: 'Support', quantity: '1', unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00', sortOrder: 1 },
      { invoiceId, orgId, sourceType: 'bundle', description: 'Hidden component', quantity: '1', unitPrice: '0.00', taxable: false, customerVisible: false, lineTotal: '0.00', sortOrder: 2 }
    ]);
    return { partnerId, orgId, invoiceId };
  });
}

/** Seed a DRAFT invoice (no invoice_number, status 'draft') with a single line. */
async function seedDraftInvoice(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Draft ${suffix}`, slug: `draft-${suffix}`, type: 'msp', plan: 'pro', status: 'active'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Draft Org ${suffix}`, slug: `draft-org-${suffix}`
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [inv] = await db.insert(invoices).values({
      partnerId, orgId, status: 'draft', currencyCode: 'USD',
      subtotal: '100.00', taxRate: '0.000', taxTotal: '0.00', total: '100.00',
      amountPaid: '0.00', balance: '100.00', billToName: `Draft Org ${suffix}`
    }).returning({ id: invoices.id });
    const invoiceId = inv!.id;
    await db.insert(invoiceLines).values([
      { invoiceId, orgId, sourceType: 'manual', description: 'Consulting', quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, lineTotal: '100.00', sortOrder: 0 }
    ]);
    return { partnerId, orgId, invoiceId };
  });
}

describe.runIf(RUN)('renderInvoicePdf / getInvoicePdf round-trip', () => {
  it('renders a valid PDF, stores it in invoice_documents, and reads it back', async () => {
    const f = await seedIssuedInvoice();

    const { documentId, sha256 } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(documentId).toBeTruthy();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);

    // The stored bytea round-trips as a valid %PDF- buffer.
    const stored = await withSystemDbAccessContext(() => getInvoicePdf(f.invoiceId));
    expect(stored).not.toBeNull();
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored!.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // invoice_documents row has the matching sha256.
    const [docRow] = await withSystemDbAccessContext(() =>
      db.select({ sha256: invoiceDocuments.sha256, orgId: invoiceDocuments.orgId })
        .from(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, f.invoiceId)).limit(1)
    );
    expect(docRow!.sha256).toBe(sha256);
    expect(docRow!.orgId).toBe(f.orgId);

    // invoices.pdf_document_ref + pdf_sha256 point at the artifact.
    const [invRow] = await withSystemDbAccessContext(() =>
      db.select({ ref: invoices.pdfDocumentRef, sha: invoices.pdfSha256 })
        .from(invoices).where(eq(invoices.id, f.invoiceId)).limit(1)
    );
    expect(invRow!.ref).toBe(documentId);
    expect(invRow!.sha).toBe(sha256);
  });

  it('is generate-once safe: re-rendering upserts the single document row', async () => {
    const f = await seedIssuedInvoice();
    await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId)); // second render must not duplicate
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: invoiceDocuments.id }).from(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, f.invoiceId))
    );
    expect(rows).toHaveLength(1);
  });

  it('getInvoicePdf returns null when no document has been rendered', async () => {
    const f = await seedIssuedInvoice();
    const stored = await withSystemDbAccessContext(() => getInvoicePdf(f.invoiceId));
    expect(stored).toBeNull();
  });

  it('does NOT persist a stored artifact when rendering a DRAFT (preview-only)', async () => {
    // A draft can be previewed, but invoice_documents + the pdf_* stamps must only
    // reflect the frozen issued artifact. Render a draft, assert nothing persisted.
    const f = await seedDraftInvoice();
    const rendered = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    // Bytes still come back so the preview download works.
    expect(rendered.documentId).toBeNull();
    expect(rendered.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // No invoice_documents row, and the invoice was not stamped.
    const docs = await withSystemDbAccessContext(() =>
      db.select({ id: invoiceDocuments.id }).from(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, f.invoiceId)));
    expect(docs).toHaveLength(0);
    const [invRow] = await withSystemDbAccessContext(() =>
      db.select({ ref: invoices.pdfDocumentRef, sha: invoices.pdfSha256 }).from(invoices).where(eq(invoices.id, f.invoiceId)).limit(1));
    expect(invRow!.ref).toBeNull();
    expect(invRow!.sha).toBeNull();
  });
});

describe.runIf(RUN)('sendInvoiceEmail honest outcome + org guard', () => {
  it('returns { emailed:false, reason:"no_email_service" } and keeps status sent when no email service', async () => {
    const f = await seedIssuedInvoice();
    const actor: InvoiceActor = { userId: '00000000-0000-0000-0000-0000000000c1', partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const result = await withSystemDbAccessContext(() => sendInvoiceEmail(f.invoiceId, actor));
    expect(result.emailed).toBe(false);
    expect(result.reason).toBe('no_email_service');
    expect(result.invoice.status).toBe('sent');
    expect(result.invoice.sentAt).not.toBeNull();
  });

  it('rejects a cross-org actor with 404 (not 403)', async () => {
    const f = await seedIssuedInvoice();
    const otherOrg = '00000000-0000-0000-0000-0000000000cc';
    const actor: InvoiceActor = { userId: '00000000-0000-0000-0000-0000000000c2', partnerId: f.partnerId, accessibleOrgIds: [otherOrg] };
    await expect(
      withSystemDbAccessContext(() => sendInvoiceEmail(f.invoiceId, actor))
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<InvoiceServiceError>);
  });
});

describe.runIf(RUN)('portal org guard: getCustomerInvoice / markViewed', () => {
  it('returns the invoice for its own org and hides non-visible lines', async () => {
    const f = await seedIssuedInvoice();
    const { invoice, lines } = await withSystemDbAccessContext(() => getCustomerInvoice(f.invoiceId, f.orgId));
    expect(invoice.id).toBe(f.invoiceId);
    // The seed has 3 lines, one of which is customerVisible:false (hidden bundle child).
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => Object.keys(line).sort().join(',') === 'description,lineTotal,quantity,taxable,unitPrice')).toBe(true);
  });

  it('throws 404 (not 403) when the requesting org does not own the invoice', async () => {
    const f = await seedIssuedInvoice();
    const otherOrg = '00000000-0000-0000-0000-0000000000aa';
    await expect(
      withSystemDbAccessContext(() => getCustomerInvoice(f.invoiceId, otherOrg))
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<InvoiceServiceError>);
  });

  it('markViewed stamps firstViewedAt/viewedAt for the owning org', async () => {
    const f = await seedIssuedInvoice();
    await withSystemDbAccessContext(() => markViewed(f.invoiceId, f.orgId));
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ firstViewedAt: invoices.firstViewedAt, viewedAt: invoices.viewedAt })
        .from(invoices).where(eq(invoices.id, f.invoiceId)).limit(1)
    );
    expect(row!.firstViewedAt).not.toBeNull();
    expect(row!.viewedAt).not.toBeNull();
  });

  it('markViewed rejects a cross-org request with 404', async () => {
    const f = await seedIssuedInvoice();
    const otherOrg = '00000000-0000-0000-0000-0000000000bb';
    await expect(
      withSystemDbAccessContext(() => markViewed(f.invoiceId, otherOrg))
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<InvoiceServiceError>);
  });
});
