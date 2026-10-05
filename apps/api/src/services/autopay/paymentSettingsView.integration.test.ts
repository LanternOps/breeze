import '../../__tests__/integration/setup';
import { expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
vi.mock('./staffNotifications', () => ({ notifyAutopayStaff: vi.fn() }));
import { and, asc, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext as system } from '../../db';
import { partners, organizations, stripeConnectAccounts, orgAutopayEnrollments, orgPaymentMethods,
  orgAutopayConsents, billingPaymentSettings, billingNoticeOutbox, billingLinkTokens } from '../../db/schema';
import { createPartner, createOrganization, createUser } from '../../__tests__/integration/db-utils';
import { feeAuthorizationGaps, paymentSettingsView } from './paymentSettingsView';
import { persistCapturedAutopayMethod } from './setupCompletion';
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
  for (const noticeStatus of ['pending', 'sending', 'sent'] as const) {
    await system(() => db.update(billingNoticeOutbox).set({ status: noticeStatus }).where(eq(billingNoticeOutbox.orgId, f.org.id)));
    await system(() => requestAutopay(db, actor, { orgIds: [f.org.id], mode: 'reauthorize' }));
  }
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


it.each(['expired', 'consumed', 'revoked', 'failed', 'handler_failed', 'cancelled'] as const)(
  'reissues an unusable %s reauthorization and deduplicates concurrent retries', async reason => {
    const f = await fixture();
    const actor = { userId: null, partnerId: f.partner.id, accessibleOrgIds: [f.org.id] };
    const request = () => system(() => requestAutopay(db, actor, { orgIds: [f.org.id], mode: 'reauthorize' }));
    await request();
    const previous = await system(async () => {
      const [token] = await db.select().from(billingLinkTokens).where(and(eq(billingLinkTokens.orgId, f.org.id), eq(billingLinkTokens.purpose, 'enroll')));
      const [notice] = await db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId, f.org.id));
      if (reason === 'expired' || reason === 'consumed' || reason === 'revoked') {
        await db.update(billingLinkTokens).set(reason === 'expired' ? { expiresAt: new Date(Date.now() - 1) }
          : reason === 'consumed' ? { consumedAt: new Date() } : { revokedAt: new Date() }).where(eq(billingLinkTokens.id, token!.id));
      } else {
        await db.update(billingNoticeOutbox).set({ status: reason, attempts: 8 }).where(eq(billingNoticeOutbox.id, notice!.id));
      }
      return { token: token!, notice: notice! };
    });
    await Promise.all([request(), request()]);
    await system(async () => {
      const tokens = await db.select().from(billingLinkTokens).where(and(eq(billingLinkTokens.orgId, f.org.id), eq(billingLinkTokens.purpose, 'enroll')));
      const notices = await db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId, f.org.id));
      expect(tokens).toHaveLength(2);
      expect(notices).toHaveLength(2);
      const fresh = tokens.find(token => token.id !== previous.token.id)!;
      expect(fresh).toMatchObject({ consumedAt: null, revokedAt: null });
      expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(notices.find(notice => notice.id !== previous.notice.id)).toMatchObject({ status: 'pending' });
      expect(notices.find(notice => notice.id === previous.notice.id)!.rendered).toEqual(previous.notice.rendered);
      const [current] = await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.enrollment.id));
      expect(current).toEqual(f.enrollment);
    });
  });

it('appends consent for distinct A → B → A setups and makes each completion replay a no-op', async () => {
  const f = await fixture();
  const user = await createUser({ partnerId: f.partner.id });
  const acceptedHashes: string[] = [];
  for (const cardFeeBps of [300, 100, 300]) {
    const disclosure = await system(async () => {
      await db.update(billingPaymentSettings).set({ cardFeeBps, feeAttestedBy: user.id, feeAttestedAt: new Date() }).where(eq(billingPaymentSettings.partnerId, f.partner.id));
      return buildAutopayDisclosure(db, f.org.id, 'card');
    });
    const token = await system(() => mintBillingLinkToken(db, { orgId: f.org.id, enrollmentId: f.enrollment.id, generation: 1, purpose: 'enroll', ttlDays: 30 }));
    const captured = await withAcceptedAutopayDisclosure(disclosure.hash, () => prepareAutopayCapture({
      orgId: f.org.id, methodType: 'card', consentAccepted: true, returnTo: 'public', tokenId: token.id,
      contactEmail: 'billing@example.test', ip: null, userAgent: null,
    }, 'setup_page'));
    const method = { id: `pm_${f.org.id}`, type: 'card', customer: f.enrollment.stripeCustomerId,
      card: { brand: 'visa', funding: 'credit', last4: '1234', exp_month: 12, exp_year: 2030, country: 'US',
        wallet: null, networks: { available: ['visa'], preferred: null } } } as Stripe.PaymentMethod;
    await Promise.all([1, 2].map(() => persistCapturedAutopayMethod(captured.id, method, 'activated', `seti_${captured.id}`, null)));
    acceptedHashes.push(disclosure.textHash);
    const consents = await system(() => db.select().from(orgAutopayConsents)
      .where(eq(orgAutopayConsents.enrollmentId, f.enrollment.id)).orderBy(asc(orgAutopayConsents.createdAt)));
    expect(consents.map(consent => consent.consentTextHash)).toEqual(['old', ...acceptedHashes]);
    expect(consents.at(-1)!.feeTerms).toEqual(disclosure.feeTerms);
  }
  expect(acceptedHashes[2]).toBe(acceptedHashes[0]);
  expect(acceptedHashes[1]).not.toBe(acceptedHashes[0]);
  expect(await system(() => feeAuthorizationGaps(db, f.partner.id))).toEqual([]);
});

it('reports the attestation on file with the attester name under the partner context (#7897)', async () => {
  const f = await fixture();
  const user = await createUser({ partnerId: f.partner.id, name: 'Pat Attester' });
  const attestedAt = new Date('2026-10-05T03:58:34.000Z');
  await system(() => db.update(billingPaymentSettings).set({ feeAttestedBy: user.id, feeAttestedAt: attestedAt })
    .where(eq(billingPaymentSettings.partnerId, f.partner.id)));
  const view = await withDbAccessContext({ scope: 'partner', orgId: null, currentPartnerId: f.partner.id,
    accessiblePartnerIds: [f.partner.id], accessibleOrgIds: [f.org.id] }, () => paymentSettingsView(db, f.partner.id));
  expect(view.feeAttestation).toEqual({ attestedAt: attestedAt.toISOString(), attestedByName: 'Pat Attester' });
  expect(view.effective.feeAttested).toBe(true);
  const orgView = await withDbAccessContext({ scope: 'partner', orgId: null, currentPartnerId: f.partner.id,
    accessiblePartnerIds: [f.partner.id], accessibleOrgIds: [f.org.id] }, () => paymentSettingsView(db, f.partner.id, f.org.id));
  expect('feeAttestation' in orgView).toBe(false);
});
it('reports a current method with no consent on file as null authorization (#7897)', async () => {
  const f = await fixture();
  // Consents are append-only; a new generation leaves the current method with none on file.
  await system(() => db.update(orgAutopayEnrollments).set({ generation: 2 }).where(eq(orgAutopayEnrollments.id, f.enrollment.id)));
  expect(await system(() => feeAuthorizationGaps(db, f.partner.id))).toEqual([expect.objectContaining({
    orgId: f.org.id, authorizedCardFeeBps: null, authorizedAchFeeAmount: null, cardFeeBps: 300 })]);
});

it('lists a client with no authorization on file when the configured fee is zero', async () => {
  const f = await fixture();
  await system(async () => {
    await db.update(billingPaymentSettings).set({ cardFeeBps: 0, achFeeAmount: '0.00' }).where(eq(billingPaymentSettings.partnerId, f.partner.id));
    // The fixture's consent authorizes 0 bps: equal to the configured fee, so not listed.
    expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([]);
    await db.update(orgAutopayEnrollments).set({ generation: 2 }).where(eq(orgAutopayEnrollments.id, f.enrollment.id));
    expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([expect.objectContaining({
      orgId: f.org.id, authorizedCardFeeBps: null, authorizedAchFeeAmount: null, cardFeeBps: 0 })]);
  });
});

// 2a-1: the effective cap is the lower of the accepted and the configured one, so an MSP who
// raises or removes the cap needs the client to accept the new terms through the same flow.
it('a cap change issues one new reauthorization with generic payment-terms copy (2a-1)', async () => {
  const f = await fixture();
  const actor = { userId: null, partnerId: f.partner.id, accessibleOrgIds: [f.org.id] };
  const request = () => system(() => requestAutopay(db, actor, { orgIds: [f.org.id], mode: 'reauthorize' }));
  const notices = () => system(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId, f.org.id)));
  await request(); await request();
  expect(await notices()).toHaveLength(1);
  await system(() => db.update(billingPaymentSettings).set({ autopayCapEnabled: true, autopayCapAmount: '500.00', autopayCapCurrency: 'USD' })
    .where(eq(billingPaymentSettings.partnerId, f.partner.id)));
  await request(); await request();
  const all = await notices();
  expect(all).toHaveLength(2);
  for (const notice of all) {
    const text = (notice.rendered as { text: string }).text;
    expect(text).toContain('updated its payment terms'); expect(text).not.toContain('processing fee terms');
  }
});
it('lists a client whose accepted cap is narrower than the configured one, and only then (2a-1)', async () => {
  const f = await fixture();
  await system(async () => {
    // Equal fees: only the cap can make the client appear.
    await db.update(billingPaymentSettings).set({ cardFeeBps: 0, achFeeAmount: '0.00' }).where(eq(billingPaymentSettings.partnerId, f.partner.id));
    await db.insert(orgAutopayConsents).values({ ...f.consent, consentTextHash: 'capped', createdAt: new Date('2026-10-04'),
      scheduleTerms: { offsetDays: 0, rule: 'later', cap: { enabled: true, amount: '100.00', currency: 'USD' } } });
    // The cap the client accepted is still the configured one: nothing to re-authorize.
    await db.update(billingPaymentSettings).set({ autopayCapEnabled: true, autopayCapAmount: '100.00', autopayCapCurrency: 'USD' })
      .where(eq(billingPaymentSettings.partnerId, f.partner.id));
    expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([]);
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ autopayCapEnabled: true, autopayCapAmount: '500.00', autopayCapCurrency: 'USD' }, { enabled: true, amount: '500.00', currency: 'USD' }],
      [{ autopayCapEnabled: false, autopayCapAmount: null, autopayCapCurrency: null }, { enabled: false }],
    ];
    for (const [settings, configured] of cases) {
      await db.update(billingPaymentSettings).set(settings).where(eq(billingPaymentSettings.partnerId, f.partner.id));
      expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([expect.objectContaining({ orgId: f.org.id,
        authorizedCardFeeBps: 0, cardFeeBps: 0,
        capGap: { authorized: { enabled: true, amount: '100.00', currency: 'USD' }, configured } })]);
    }
    // A configured cap below the accepted one is not a gap: re-authorizing would not widen anything.
    await db.update(billingPaymentSettings).set({ autopayCapEnabled: true, autopayCapAmount: '50.00', autopayCapCurrency: 'USD' })
      .where(eq(billingPaymentSettings.partnerId, f.partner.id));
    expect(await feeAuthorizationGaps(db, f.partner.id)).toEqual([]);
  });
});
