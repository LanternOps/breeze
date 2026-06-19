import './setup';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users, invoices } from '../../db/schema';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';

interface Fixture { partnerId: string; orgId: string; userId: string }

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `Contact MSP ${sfx}`, slug: `contact-msp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'COrg', slug: `co-${sfx}` })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `c-${sfx}@x.io`, name: 'C', status: 'active' })
      .returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('billing contact info — snapshot at issue', () => {
  runDb('persists partner seller contact fields', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    await withSystemDbAccessContext(() => svc.updatePartnerBillingSettings({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingPhone: '+1 555 0100', billingWebsite: 'acme.test',
      billingAddressLine1: '1 Main St', billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30. Late fee 1.5%/mo.',
    }, actor));
    const [p] = await withSystemDbAccessContext(() => db.select().from(partners).where(eq(partners.id, f.partnerId)).limit(1));
    expect(p!.billingCompanyName).toBe('Acme MSP LLC');
    expect(p!.billingTermsAndConditions).toContain('Net 30');
  });

  runDb('snapshots seller contact + defaults T&C onto an issued invoice', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    await withSystemDbAccessContext(() => svc.updatePartnerBillingSettings({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingAddressLine1: '1 Main St', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30.',
    }, actor));
    const inv = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId }, actor));
    await withSystemDbAccessContext(() => svc.addManualLine(inv.id, { description: 'Labor', quantity: 1, unitPrice: 100, taxable: false }, actor));
    await withSystemDbAccessContext(() => svc.issueInvoice(inv.id, actor));
    const [issued] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1));
    const snap = issued!.sellerSnapshot as { name: string; address: { line1: string } };
    expect(snap.name).toBe('Acme MSP LLC');
    expect(snap.address.line1).toBe('1 Main St');
    expect(issued!.termsAndConditions).toBe('Net 30.');
  });

  runDb('does not overwrite a draft-supplied T&C with the partner default', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    await withSystemDbAccessContext(() => svc.updatePartnerBillingSettings({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingTermsAndConditions: 'Default terms',
    }, actor));
    const inv = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId, termsAndConditions: 'Custom per-invoice terms' }, actor));
    await withSystemDbAccessContext(() => svc.addManualLine(inv.id, { description: 'Labor', quantity: 1, unitPrice: 100, taxable: false }, actor));
    await withSystemDbAccessContext(() => svc.issueInvoice(inv.id, actor));
    const [issued] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1));
    expect(issued!.termsAndConditions).toBe('Custom per-invoice terms');
  });
});
