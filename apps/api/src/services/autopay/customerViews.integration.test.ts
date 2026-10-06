import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withSystemDbAccessContext } from '../../db';
import { billingLinkTokens, organizations, orgAutopayEnrollments, orgPaymentMethods, stripeConnectAccounts } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { mintBillingLinkToken } from './linkTokens';
import { stopAutopayByClient, withAutopayStopToken } from './enrollmentLifecycle';
import { completeAutopaySetup } from './enrollmentService';
import { completeOwnedAutopaySetup, describeAutopayLinkFailure, getAutopayStopView, resolveAutopayLinkIdentity, resolveAutopayReturnIdentity, resolveAutopayOrgIdentity } from './customerViews';
import { partners } from '../../db/schema';

// Keep identity, ownership, disclosure, and method queries real. Stripe completion
// is the external boundary; verify that ownership rejects before reaching it.
vi.mock('./enrollmentService', () => ({ completeAutopaySetup: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const system = withSystemDbAccessContext;
async function fixture() {
  return system(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id,
      stripeAccountId: `acct_${partner.id}`, apiKey: 'enc:synthetic', keyLast4: 'test', accountCountry: 'US' }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
    const identity = { orgId: org.id, partnerId: partner.id, enrollmentId: enrollment!.id, generation: 1 };
    const link = await mintBillingLinkToken(db, { ...identity, purpose: 'enroll', ttlDays: 1 });
    const [attempt] = await db.insert(autopaySetupAttempts).values({ ...identity, tokenId: link.id, source: 'setup_page',
      methodType: 'card', stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
      checkoutSessionId: `cs_${randomUUID().replaceAll('-', '')}`, consentSnapshot: {} }).returning();
    return { identity: { ...identity, tokenId: link.id }, link, attempt: attempt! };
  });
}

describe('customer token and return ownership against PostgreSQL', () => {
  it('permits consumed-token repeat returns only for its existing attempt, never setup', async () => {
    const f = await fixture();
    await system(() => db.update(billingLinkTokens).set({ consumedAt: new Date() }).where(eq(billingLinkTokens.id, f.link.id)));
    expect(await resolveAutopayLinkIdentity(f.link.token, 'enroll')).toBeNull();
    for (let i = 0; i < 2; i++) {
      expect(await resolveAutopayReturnIdentity(f.link.token, f.attempt.checkoutSessionId!)).toEqual(f.identity);
    }
    expect(await resolveAutopayReturnIdentity(f.link.token, 'cs_other')).toBeNull();
    const other = await fixture();
    expect(await resolveAutopayReturnIdentity(f.link.token, other.attempt.checkoutSessionId!)).toBeNull();
    expect(await resolveAutopayReturnIdentity('x'.repeat(43), f.attempt.checkoutSessionId!)).toBeNull();
  });

  it.each(['expired', 'revoked', 'wrong-purpose', 'generation', 'inactive', 'deleted'] as const)(
    'rejects %s authority on completion as well as normal admission', async kind => {
      const f = await fixture();
      await system(async () => {
        if (kind === 'expired') await db.update(billingLinkTokens).set({ expiresAt: new Date(0) }).where(eq(billingLinkTokens.id, f.link.id));
        if (kind === 'revoked') await db.update(billingLinkTokens).set({ revokedAt: new Date() }).where(eq(billingLinkTokens.id, f.link.id));
        if (kind === 'wrong-purpose') await db.update(billingLinkTokens).set({ purpose: 'stop_autopay' }).where(eq(billingLinkTokens.id, f.link.id));
        if (kind === 'generation') await db.update(orgAutopayEnrollments).set({ generation: 2 }).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId));
        if (kind === 'inactive') await db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, f.identity.orgId));
        if (kind === 'deleted') await db.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, f.identity.orgId));
      });
      expect(await resolveAutopayReturnIdentity(f.link.token, f.attempt.checkoutSessionId!)).toBeNull();
      expect(await resolveAutopayLinkIdentity(f.link.token, 'enroll')).toBeNull();
      if (kind === 'inactive' || kind === 'deleted') expect(await resolveAutopayOrgIdentity(f.identity.orgId)).toBeNull();
    },
  );

  it.each(['orgId', 'partnerId', 'tokenId', 'enrollmentId', 'generation'] as const)(
    'rejects a mismatched %s before completing with Stripe', async key => {
      const f = await fixture();
      const identity = { ...f.identity, [key]: key === 'generation' ? 2 : randomUUID() };
      await expect(completeOwnedAutopaySetup(identity, f.attempt.checkoutSessionId!)).rejects.toMatchObject({ status: 404 });
      expect(completeAutopaySetup).not.toHaveBeenCalled();
    },
  );

  it('rechecks stop authority after admission and preserves a newer enrollment', async () => {
    const f = await fixture();
    const stop = await system(() => mintBillingLinkToken(db, { ...f.identity, purpose: 'stop_autopay', ttlDays: 1 }));
    expect(await resolveAutopayLinkIdentity(stop.token, 'stop_autopay')).toMatchObject({ generation: 1 });
    // Model re-enrollment committed after route admission but before its mutation.
    await system(() => db.update(orgAutopayEnrollments).set({ generation: 2 }).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId)));
    await expect(withAutopayStopToken(stop.token, () => system(() => stopAutopayByClient(db, {
      orgId: f.identity.orgId, source: 'link',
    })))).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    const [enrollment] = await system(() => db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId)));
    expect(enrollment).toMatchObject({ status: 'requested', generation: 2 });
  });

  it('uses live debit evidence for the owned setup and closes the DB context before completion', async () => {
    const f = await fixture();
    await system(() => db.insert(orgPaymentMethods).values({ orgId: f.identity.orgId, enrollmentId: f.identity.enrollmentId,
      stripePaymentMethodId: 'pm_debit', type: 'card', cardBrand: 'Visa', cardFunding: 'debit', cardLast4: '1234',
      status: 'active', isAutopayMethod: true }));
    vi.mocked(completeAutopaySetup).mockImplementationOnce(async (_partnerId, _ref, onVerifiedMethod) => {
      expect(getCurrentDbAccessContext()).toBeUndefined();
      expect(onVerifiedMethod).toEqual(expect.any(Function));
      onVerifiedMethod!({ id: 'pm_debit', type: 'card',
        card: { brand: 'visa', funding: 'debit', last4: '1234', wallet: null,
          networks: { available: ['visa'], preferred: null } },
      } as Stripe.PaymentMethod);
      return { outcome: 'activated', orgId: f.identity.orgId };
    });
    expect(await completeOwnedAutopaySetup(f.identity, f.attempt.checkoutSessionId!)).toMatchObject({
      outcome: 'activated', orgId: f.identity.orgId, methodLabel: 'Visa debit card ending in 1234', feeText: 'No processing fee applies to this card.',
      branding: { partnerName: expect.any(String), logoUrl: null },
      current: { status: expect.any(String), methodLabel: 'Visa debit card ending in 1234' },
    });
    expect(completeAutopaySetup).toHaveBeenCalledWith(f.identity.partnerId, { checkoutSessionId: f.attempt.checkoutSessionId }, expect.any(Function));
  });

  // FP-12: the return page says "for invoices issued from today" only for a first setup.
  it.each([['a first setup', false], ['a change while automatic payments were already on', true]] as const)(
    'reports whether %s changed the method', async (_label, alreadyOn) => {
      const f = await fixture();
      if (alreadyOn) await system(() => db.update(orgAutopayEnrollments).set({ status: 'active', effectiveFrom: new Date('2026-09-01T00:00:00Z') })
        .where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId)));
      vi.mocked(completeAutopaySetup).mockImplementationOnce(async () => {
        // Completion keeps an earlier effective date and sets it only on a first setup.
        await system(() => db.update(orgAutopayEnrollments).set({ status: 'active',
          ...(alreadyOn ? {} : { effectiveFrom: new Date() }) }).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId)));
        return { outcome: 'activated', orgId: f.identity.orgId };
      });
      const result = await completeOwnedAutopaySetup(f.identity, f.attempt.checkoutSessionId!);
      expect(result.current).toMatchObject({ status: 'active', changed: alreadyOn });
    },
  );
});

describe('client pages are told why a link is unusable (real PostgreSQL)', () => {
  it('distinguishes an unknown, used, expired and replaced setup link, and a stopped stop link', async () => {
    const f = await fixture();
    await system(() => db.update(partners).set({ billingEmail: 'billing@msp.example' }).where(eq(partners.id, f.identity.partnerId)));
    expect(await describeAutopayLinkFailure('x'.repeat(43), 'enroll')).toEqual({ error: expect.any(String), code: 'link_invalid' });

    await system(() => db.update(billingLinkTokens).set({ consumedAt: new Date() }).where(eq(billingLinkTokens.id, f.link.id)));
    await system(() => db.update(orgAutopayEnrollments).set({ status: 'active', effectiveFrom: new Date() }).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId)));
    expect(await describeAutopayLinkFailure(f.link.token, 'enroll')).toMatchObject({ code: 'link_used',
      data: { enrollmentStatus: 'active', partnerName: expect.any(String), supportEmail: 'billing@msp.example' } });

    const expired = await system(() => mintBillingLinkToken(db, { ...f.identity, purpose: 'enroll', ttlDays: 1 }));
    await system(() => db.update(billingLinkTokens).set({ expiresAt: new Date(0) }).where(eq(billingLinkTokens.id, expired.id)));
    expect(await describeAutopayLinkFailure(expired.token, 'enroll')).toMatchObject({ code: 'link_expired' });

    // A resend bumps the generation and revokes older links.
    const old = await system(() => mintBillingLinkToken(db, { ...f.identity, purpose: 'stop_autopay', ttlDays: 1 }));
    await system(async () => {
      await db.update(billingLinkTokens).set({ revokedAt: new Date() }).where(eq(billingLinkTokens.id, old.id));
      await db.update(orgAutopayEnrollments).set({ generation: 2 }).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId));
    });
    expect(await describeAutopayLinkFailure(old.token, 'stop_autopay')).toMatchObject({ code: 'link_replaced' });
  });

  it('a stop link used to stop reports automatic payments are off, and the stop view says who stopped them', async () => {
    const f = await fixture();
    await system(() => db.update(orgAutopayEnrollments).set({ status: 'active', effectiveFrom: new Date() }).where(eq(orgAutopayEnrollments.id, f.identity.enrollmentId)));
    const stop = await system(() => mintBillingLinkToken(db, { ...f.identity, purpose: 'stop_autopay', ttlDays: 1 }));
    await withAutopayStopToken(stop.token, () => system(() => stopAutopayByClient(db, { orgId: f.identity.orgId, source: 'link' })));
    expect(await describeAutopayLinkFailure(stop.token, 'stop_autopay')).toMatchObject({ code: 'link_used', data: { enrollmentStatus: 'cancelled' } });
    expect(await getAutopayStopView(f.identity.orgId)).toMatchObject({ enrollment: { status: 'cancelled', cancelSource: 'client',
      cancelledAt: expect.any(String) }, method: null, openInvoiceCount: 0 });
  });
});
