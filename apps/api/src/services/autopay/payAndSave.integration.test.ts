import '../../__tests__/integration/setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceStripePayments, orgAutopayEnrollments, partners, stripeConnectAccounts } from '../../db/schema';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
import { invoiceRoutes } from '../../routes/portal/invoices';
import { finishCardPayAndSave } from './payAndSave';
import { getPartnerStripeClient } from '../partnerStripe';
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: vi.fn() }));

describe('pay-and-save real DB fences', () => {
  it('portal invoice GET reads the complete offer with org-only RLS and denies another org', async () => {
    const partner = await createPartner({ name: 'Example MSP' });
    const org = await createOrganization({ partnerId: partner.id });
    const other = await createOrganization({ partnerId: partner.id });
    const invoice = await withSystemDbAccessContext(async () => {
      await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
      const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: 'acct_offer', apiKey: 'enc:synthetic', keyLast4: 'test' }).returning();
      await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id, stripeConnectionId: connection!.id, stripeAccountId: 'acct_offer' });
      const [row] = await db.insert(invoices).values({ orgId: org.id, partnerId: partner.id, currencyCode: 'USD', status: 'sent' }).returning();
      return row!;
    });
    function app(orgId: string) {
      const a = new Hono();
      a.use('*', async (c, next) => {
        c.set('portalAuth', { user: { id: 'portal-user', orgId, email: 'billing@example.test', name: 'Customer', contactId: null,
          receiveNotifications: true, status: 'active' }, token: 'test', authMethod: 'bearer', timezone: 'UTC' });
        await withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null }, async () => {
          expect(await db.select({ id: partners.id }).from(partners)).toEqual([]);
          await next();
        });
      });
      a.route('/', invoiceRoutes); return a;
    }
    const response = await app(org.id).request(`/invoices/${invoice.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).autopay).toEqual({ eligible: true, consentText: expect.stringContaining('Example MSP'),
      consentVersion: '2026-10-01.v1', disclosureHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await app(other.id).request(`/invoices/${invoice.id}`)).status).toBe(404);
    await withSystemDbAccessContext(() => db.update(partners).set({ autopayEnabled: false }).where(eq(partners.id, partner.id)));
    expect((await (await app(org.id).request(`/invoices/${invoice.id}`)).json()).autopay).toBeNull();
  });
  it('never retrieves or saves a paid Stripe session whose mapping has no booked invoice payment', async () => {
    const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
    await withSystemDbAccessContext(async () => {
      const [invoice] = await db.insert(invoices).values({ orgId: org.id, partnerId: partner.id, currencyCode: 'USD', status: 'void' }).returning();
      await db.insert(invoiceStripePayments).values({ invoiceId: invoice!.id, orgId: org.id, stripeAccountId: 'acct_test',
        stripeObjectType: 'checkout_session', stripeObjectId: 'cs_unbooked', amount: '100.00', currency: 'USD', status: 'pending' });
    });
    vi.mocked(getPartnerStripeClient).mockClear();
    await finishCardPayAndSave(partner.id, 'cs_unbooked');
    expect(getPartnerStripeClient).not.toHaveBeenCalled();
  });
});
