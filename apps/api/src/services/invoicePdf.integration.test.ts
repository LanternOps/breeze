import { describe, it, expect, vi } from 'vitest';

// Same rationale as invoiceService.issue.integration.test.ts: events are
// fire-and-forget BullMQ side effects; mock the emitter so these DB-correctness
// tests don't open a socket to the unauthenticated test Redis and hang.
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations, invoices, invoiceLines, invoiceDocuments } from '../db/schema';
import { eq } from 'drizzle-orm';
import { renderInvoicePdf, getInvoicePdf } from './invoicePdf';

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
});
