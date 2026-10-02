import '../../__tests__/integration/setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { billingLinkTokens, invoices, orgAutopayEnrollments, stripeConnectAccounts } from '../../db/schema';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { mintBillingLinkToken, resolveBillingLinkToken, revokeBillingLinkTokens } from './linkTokens';
import type { BillingLinkPurpose } from '@breeze/shared';
async function fixture() {
  return withSystemDbAccessContext(async () => {
    const p = await createPartner();
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: p.id, stripeAccountId: `acct_${p.id}`, apiKey: 'enc:synthetic', keyLast4: 'test' }).returning();
    const orgs = [];
    for (let i = 0; i < 2; i++) {
      const org = await createOrganization({ partnerId: p.id });
      const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: p.id, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
      const [invoice] = await db.insert(invoices).values({ partnerId: p.id, orgId: org.id, currencyCode: 'USD' }).returning();
      orgs.push({ orgId: org.id, enrollmentId: enrollment!.id, invoiceId: invoice!.id });
    }
    return { a: orgs[0]!, b: orgs[1]!, partnerId: p.id };
  });
}
const system = withSystemDbAccessContext;
afterEach(() => vi.restoreAllMocks());
describe('C4 billing links against real PostgreSQL', () => {
  it('binds resolution to purpose, token and caller org; expiry boundary is exclusive', async () => {
    const f = await fixture();
    const token = await system(() => mintBillingLinkToken(db, { ...f.a, purpose: 'enroll', ttlDays: 1 }));
    expect(await system(() => resolveBillingLinkToken(db, token.token, 'stop_autopay'))).toBeNull();
    expect(await system(() => resolveBillingLinkToken(db, 'a'.repeat(43), 'enroll'))).toBeNull();
    expect(await withDbAccessContext({ scope: 'organization', orgId: f.b.orgId, accessibleOrgIds: [f.b.orgId] }, () => resolveBillingLinkToken(db, token.token, 'enroll'))).toBeNull();
    const row = await system(() => resolveBillingLinkToken(db, token.token, 'enroll'));
    expect(row!.id).toBe(token.id);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(row!.expiresAt.getTime() - 1);
    expect(await system(() => resolveBillingLinkToken(db, token.token, 'enroll'))).not.toBeNull();
    clock.mockReturnValue(row!.expiresAt.getTime());
    expect(await system(() => resolveBillingLinkToken(db, token.token, 'enroll'))).toBeNull();
  });
  it.each(['enroll','confirm_payment','skip_invoice','stop_autopay'] as BillingLinkPurpose[])('consumption semantics for %s', async purpose => {
    const f = await fixture();
    const token = await system(() => mintBillingLinkToken(db, { ...f.a, purpose, ttlDays: 1 }));
    await system(() => db.update(billingLinkTokens).set({ consumedAt: new Date() }).where(eq(billingLinkTokens.id, token.id)));
    const row = await system(() => resolveBillingLinkToken(db, token.token, purpose));
    if (purpose === 'enroll' || purpose === 'confirm_payment') expect(row).toBeNull();
    else expect(row!.id).toBe(token.id);
  });
  it('revokes only matching org, enrollment, invoice and purpose and leaves the other org intact', async () => {
    const f = await fixture();
    const [otherInvoice] = await system(() => db.insert(invoices).values({ partnerId: f.partnerId, orgId: f.a.orgId, currencyCode: 'USD' }).returning());
    const a = await system(() => mintBillingLinkToken(db, { ...f.a, purpose: 'skip_invoice', ttlDays: 1 }));
    const other = await system(() => mintBillingLinkToken(db, { ...f.a, invoiceId: otherInvoice!.id, purpose: 'skip_invoice', ttlDays: 1 }));
    const stop = await system(() => mintBillingLinkToken(db, { ...f.a, purpose: 'stop_autopay', ttlDays: 1 }));
    const b = await system(() => mintBillingLinkToken(db, { ...f.b, purpose: 'skip_invoice', ttlDays: 1 }));
    expect(await system(() => revokeBillingLinkTokens(db, { ...f.a, enrollmentId: f.b.enrollmentId }))).toBe(0);
    expect(await system(() => revokeBillingLinkTokens(db, { ...f.a, purpose: 'skip_invoice' }))).toBe(1);
    expect(await system(() => resolveBillingLinkToken(db, a.token, 'skip_invoice'))).toBeNull();
    for (const [token, purpose] of [[other.token, 'skip_invoice'], [stop.token, 'stop_autopay'], [b.token, 'skip_invoice']] as const) {
      expect(await system(() => resolveBillingLinkToken(db, token, purpose))).not.toBeNull();
    }
    expect(await system(() => revokeBillingLinkTokens(db, { orgId: f.a.orgId }))).toBe(2);
    expect(await system(() => resolveBillingLinkToken(db, b.token, 'skip_invoice'))).not.toBeNull();
  });
});
