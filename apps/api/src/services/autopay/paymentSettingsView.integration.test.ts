import '../../__tests__/integration/setup';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext as system } from '../../db';
import { partners, organizations, stripeConnectAccounts, orgAutopayEnrollments, orgPaymentMethods,
  orgAutopayConsents, billingPaymentSettings, billingNoticeOutbox, billingLinkTokens } from '../../db/schema';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { feeAuthorizationGaps } from './paymentSettingsView';
import { requestAutopay } from './enrollmentLifecycle';
import { mintBillingLinkToken } from './linkTokens';
import { prepareAutopayCapture } from './setupSession';
import { buildAutopayDisclosure, withAcceptedAutopayDisclosure } from './consentText';

async function fixture(status: 'active' | 'paused' = 'active') {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return system(async () => {
    await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
    await db.update(organizations).set({ billingAddressCountry: 'US', billingAddressRegion: 'NY',
      currencyCode: 'USD', billingContact: { email: 'billing@example.test' } }).where(eq(organizations.id, org.id));
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id,
      stripeAccountId: `acct_${partner.id}`, apiKey: 'enc:synthetic', keyLast4: 'test', accountCountry: 'US',
      autopayCapabilitiesCheckedAt: new Date(), autopayMissingPermissions: [] }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId, stripeCustomerId: `cus_${org.id}`, status,
      effectiveFrom: new Date('2026-09-01'), pausedAt: status === 'paused' ? new Date('2026-10-01') : null }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id,
      stripePaymentMethodId: `pm_${org.id}`, type: 'card', cardFunding: 'credit', status: 'active', isAutopayMethod: true }).returning();
    await db.insert(billingPaymentSettings).values({ partnerId: partner.id, cardFeeBps: 300, achFeeAmount: '2.50' });
    const consent = { orgId: org.id, enrollmentId: enrollment!.id, generation: 1, paymentMethodId: method!.id,
      consentTextVersion: 'test', consentTextHash: 'old', source: 'setup_page' as const, contactEmail: 'billing@example.test',
      scheduleTerms: { offsetDays: 0, rule: 'later' as const, cap: { enabled: false as const } },
      feeTerms: { methodType: 'card' as const, cardFeeBps: 0, achFeeAmount: '0.00', feeAttested: true, currency: 'USD' } };
    await db.insert(orgAutopayConsents).values({ ...consent, createdAt: new Date('2026-09-01') });
    return { partner, org, enrollment: enrollment!, consent };
  });
}
it('uses only current-generation/latest-method consent and confines partner and organization results', async () => {
  const f = await fixture(); const other = await fixture();
  await system(async () => {
    expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([expect.objectContaining({ orgId: f.org.id, authorizedCardFeeBps: 0, cardFeeBps: 300 })]);
    expect(await feeAuthorizationGaps(db, f.partner.id, other.org.id)).toEqual([]);
    // Consent in another generation cannot raise this generation's ceiling.
    await db.insert(orgAutopayConsents).values({ ...f.consent, generation: 2, consentTextHash: 'future',
      feeTerms: { ...f.consent.feeTerms, cardFeeBps: 300 }, createdAt: new Date('2026-10-02') });
    expect(await feeAuthorizationGaps(db, f.partner.id)).toHaveLength(1);
    await db.insert(orgAutopayConsents).values({ ...f.consent, consentTextHash: 'updated',
      feeTerms: { ...f.consent.feeTerms, cardFeeBps: 300 }, createdAt: new Date('2026-10-03') });
    expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([]);
    await db.insert(billingPaymentSettings).values({ orgId: other.org.id, cardFeeBps: 0 });
    expect(await feeAuthorizationGaps(db, other.partner.id)).toEqual([]);
  });
});
it.each(['active', 'paused'] as const)('deduplicates concurrent %s reauthorization without mutating enrollment', async status => {
  const f = await fixture(status);
  const actor = { userId: null, partnerId: f.partner.id, accessibleOrgIds: [f.org.id] };
  await Promise.all([1, 2].map(() => system(() => requestAutopay(db, actor, { orgIds: [f.org.id], mode: 'reauthorize' }))));
  await system(async () => {
    const [current] = await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.enrollment.id));
    expect(current).toEqual(f.enrollment);
    const notices = await db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId, f.org.id));
    expect(notices).toHaveLength(1); expect(notices[0]!.kind).toBe('autopay_request');
    const tokens = await db.select().from(billingLinkTokens).where(eq(billingLinkTokens.orgId, f.org.id));
    expect(tokens.filter(token => token.purpose === 'enroll')).toHaveLength(1);
  });
});

it('captures current terms through a real same-generation token while preserving paused enrollment', async () => {
  const f = await fixture('paused');
  const { token, disclosure } = await system(async () => ({
    token: await mintBillingLinkToken(db, { orgId: f.org.id, enrollmentId: f.enrollment.id, generation: 1, purpose: 'enroll', ttlDays: 30 }),
    disclosure: await buildAutopayDisclosure(db, f.org.id, 'card'),
  }));
  const captured = await withAcceptedAutopayDisclosure(disclosure.hash, () => prepareAutopayCapture({
    orgId: f.org.id, methodType: 'card', consentAccepted: true, returnTo: 'public', tokenId: token.id,
    contactEmail: 'billing@example.test', ip: null, userAgent: null,
  }, 'setup_page'));
  expect(captured.generation).toBe(1);
  expect(captured.consentSnapshot).toMatchObject({ feeTerms: disclosure.feeTerms });
  const [current] = await system(() => db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.enrollment.id)));
  expect(current).toEqual(f.enrollment);
});
