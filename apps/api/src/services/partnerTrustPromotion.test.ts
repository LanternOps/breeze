import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpClass } from '../db/schema/orgs';

const {
  readTrust, setTrustState, getSettledCardCharge, getSignupRiskHold,
  hasFraudulentRefundMatch, closeOpenCheckouts, createAuditLog, getBillingClient,
  partnerTrustMode, sendOpsAlert, captureException,
  select, execute, runOutside, withSystem, sendEvidenceCard,
} = vi.hoisted(() => ({
  partnerTrustMode: vi.fn(() => 'enforce'),
  sendOpsAlert: vi.fn(),
  captureException: vi.fn(),
  readTrust: vi.fn(),
  setTrustState: vi.fn(),
  getSettledCardCharge: vi.fn(),
  getSignupRiskHold: vi.fn(),
  hasFraudulentRefundMatch: vi.fn(),
  closeOpenCheckouts: vi.fn(),
  createAuditLog: vi.fn(),
  getBillingClient: vi.fn(),
  select: vi.fn(),
  execute: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  sendEvidenceCard: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select, execute },
  runOutsideDbContext: runOutside,
  withSystemDbAccessContext: withSystem,
}));
vi.mock('../db/schema', () => ({
  partners: { id: 'partners.id', createdAt: 'partners.createdAt', emailVerifiedAt: 'partners.emailVerifiedAt', signupIpClass: 'partners.signupIpClass' },
  devices: { orgId: 'devices.orgId', enrollmentIpClass: 'devices.enrollmentIpClass' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerAbuseSignals: { partnerId: 'signals.partnerId', severity: 'signals.severity', resolvedAt: 'signals.resolvedAt' },
}));
vi.mock('./partnerTrust.repo', () => ({ readTrust }));
vi.mock('./partnerTrust', () => ({ setTrustState }));
vi.mock('./breezeBillingClient', () => ({ getBreezeBillingClient: getBillingClient }));
vi.mock('./partnerTrustEvidenceCard', () => ({ sendEvidenceCard }));
vi.mock('./auditService', () => ({ createAuditLogAsync: createAuditLog }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode }));
vi.mock('./opsAlerts', () => ({ sendOpsAlert }));
vi.mock('./sentry', () => ({ captureException }));

const billingClient = () => ({
  getSettledCardCharge, getSignupRiskHold, hasFraudulentRefundMatch, closeOpenCheckouts,
});

import {
  evaluateHardDenies, gatherPromotionFacts, promotionDecision, restrictOnHardDeny,
  tryAutoPromote, type PromotionFacts,
} from './partnerTrustPromotion';

const now = new Date('2026-09-02T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1_000);
const baseFacts = (): PromotionFacts => ({
  createdAt: hoursAgo(48),
  emailVerified: true,
  settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(24) },
  signupIpClass: 'residential',
  deviceIpClasses: ['business'],
  unresolvedAlerts: 0,
  billingHold: false,
  billingHoldUnknown: false,
});

const hardDenyRow = (overrides: Record<string, unknown> = {}) => ({
  trust_state: 'probation',
  signup_ip_class: 'residential',
  card_partner_id: null,
  network_partner_id: null,
  candidate_ip: null,
  suspended_ip: null,
  prefix_length: null,
  corroboration_type: null,
  corroboration_value: null,
  recidivist_partner_id: null,
  card_testing_signal_id: null,
  card_testing_score: null,
  card_testing_evidence: null,
  ...overrides,
});

/** Flattens a drizzle `sql` template into its literal text plus bound params. */
function renderSql(query: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const walk = (node: unknown): string => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (typeof node === 'object') {
      const n = node as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(n.queryChunks)) return n.queryChunks.map(walk).join('');
      if ('value' in n) {
        if (Array.isArray(n.value)) return n.value.map(walk).join('');
        params.push(n.value);
        return '$';
      }
    }
    params.push(node);
    return '$';
  };
  return { text: walk(query), params };
}

describe('evaluateHardDenies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ABUSE_SIGNAL_OVERRIDES;
    getBillingClient.mockImplementation(billingClient);
    execute.mockResolvedValue([hardDenyRow()]);
    hasFraudulentRefundMatch.mockResolvedValue(false);
  });

  it('restricts a probation partner that signed up over Tor', async () => {
    execute.mockResolvedValue([hardDenyRow({ signup_ip_class: 'tor' })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
    });
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });

  it('does not restrict on a suspended-partner network match alone', async () => {
    // No network result is returned unless SQL found a second, corroborating
    // axis; sharing an IP prefix by itself remains deliberately insufficient.
    execute.mockResolvedValue([hardDenyRow()]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
  });

  it('restricts on an IP prefix plus the same email domain and names both axes', async () => {
    execute.mockResolvedValue([hardDenyRow({
      network_partner_id: 'suspended-1',
      candidate_ip: '198.51.100.9',
      suspended_ip: '198.51.100.25',
      prefix_length: 24,
      corroboration_type: 'email_domain',
      corroboration_value: 'example.com',
    })]);

    const decision = await evaluateHardDenies('p1');

    expect(decision).toEqual(expect.objectContaining({
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: expect.objectContaining({
        matchedAxes: ['network_prefix', 'email_domain'],
        network: expect.objectContaining({ prefixLength: 24 }),
        corroboration: { type: 'email_domain', value: 'example.com' },
      }),
    }));
  });

  it('restricts on a card fingerprint belonging to a suspended-for-abuse partner', async () => {
    execute.mockResolvedValue([hardDenyRow({ card_partner_id: 'suspended-1' })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual(expect.objectContaining({
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: expect.objectContaining({ matchedSuspendedPartnerId: 'suspended-1' }),
    }));
  });

  it('uses the billing fraudulent-refund match as an independent fraud identity rule', async () => {
    hasFraudulentRefundMatch.mockResolvedValue(true);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: { matchedAxes: ['fraudulent_refund_customer'] },
    });
  });

  it('restricts on an open card_testing signal at alert score and carries its evidence', async () => {
    execute.mockResolvedValue([hardDenyRow({
      card_testing_signal_id: 'sig-1',
      card_testing_score: 100,
      card_testing_evidence: {
        partnerName: 'Example MSP',
        distinctPaymentMethods: 17,
        failedAttempts: 11,
        spanMinutes: 42.5,
        paymentMethodsFirstSeenAt: '2026-11-07T18:00:00.000Z',
        paymentMethodsLastSeenAt: '2026-11-07T18:42:30.000Z',
        identitySyncedAt: '2026-11-07T18:45:00.000Z',
      },
    })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({
      restrict: true,
      reason: 'auto:card_testing',
      evidence: {
        matchedAxes: ['billing.card_testing'],
        signalId: 'sig-1',
        score: 100,
        alertScore: 70,
        distinctPaymentMethods: 17,
        failedAttempts: 11,
        spanMinutes: 42.5,
        paymentMethodsFirstSeenAt: '2026-11-07T18:00:00.000Z',
        paymentMethodsLastSeenAt: '2026-11-07T18:42:30.000Z',
      },
    });
    // A local, independently sufficient signal: no remote billing lookup.
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });

  it('gates card_testing on the configured alert score, not a separate constant', async () => {
    process.env.ABUSE_SIGNAL_OVERRIDES = JSON.stringify({ 'severity.alert_score': 85 });

    await evaluateHardDenies('p1');

    const { text, params } = renderSql(execute.mock.calls[0]![0]);
    expect(text).toContain("signal_key = 'billing.card_testing'");
    expect(text).toMatch(/pas\.score >= \$/);
    expect(params).toContain(85);
    delete process.env.ABUSE_SIGNAL_OVERRIDES;
  });

  it('restricts on a remote-tool instance match with a suspended-for-abuse partner', async () => {
    execute.mockResolvedValue([hardDenyRow({ recidivist_partner_id: 'suspended-9' })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({
      restrict: true,
      reason: 'auto:recidivist_endpoint',
      evidence: {
        matchedAxes: ['remote_tool_guid', 'suspended_for_abuse'],
        matchedSuspendedPartnerId: 'suspended-9',
      },
    });
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });

  it('only matches the recidivist axis on the stable remote-tool instance id behind an open signal', async () => {
    await evaluateHardDenies('p1');

    const { text } = renderSql(execute.mock.calls[0]![0]);
    expect(text).toContain("sf.kind = 'remote_tool_guid'");
    expect(text).toContain("tf.kind = 'remote_tool_guid'");
    expect(text).toContain("signal_key = 'rmm.recidivist_endpoint'");
    // Bounded to recent abuse suspensions, like the network axis.
    expect(text).toMatch(/FROM recent_suspended_abuse s\s+JOIN abuse_endpoint_fingerprints sf/);
  });

  it.each(['trusted', 'restricted'] as const)('never restricts an already-%s partner', async (trustState) => {
    // In production the SQL target CTE's WHERE clause already excludes
    // non-probation partners, so this row would never come back at all. Set
    // it on the mocked row anyway (rather than an unconditional empty array
    // for both cases) to exercise evaluateHardDenies' own belt-and-suspenders
    // trust_state check independently of the SQL filter.
    execute.mockResolvedValue([hardDenyRow({
      trust_state: trustState,
      card_testing_signal_id: 'sig-1',
      card_testing_score: 100,
      card_testing_evidence: { distinctPaymentMethods: 17 },
      recidivist_partner_id: 'suspended-9',
    })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });
});

describe('promotionDecision', () => {
  it.each([
    ['link charge', { settledCard: null }, ['card_not_settled']],
    ['23 hour card', { settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(23) } }, ['settled_too_recent']],
    ['refunded card', { settledCard: null }, ['card_not_settled']],
    ['disputed card', { settledCard: null }, ['card_not_settled']],
    ['hosting signup', { signupIpClass: 'hosting' as IpClass }, ['signup_ip_hosting']],
    ['unknown signup', { signupIpClass: 'unknown' as IpClass }, ['signup_ip_unclassified']],
    ['device on hosting', { deviceIpClasses: ['hosting'] as IpClass[] }, []],
    ['device on tor', { deviceIpClasses: ['tor'] as IpClass[] }, ['device_on_tor']],
    ['unresolved alert', { unresolvedAlerts: 1 }, ['unresolved_alert']],
    ['billing hold', { billingHold: true, billingHoldUnknown: false }, ['billing_hold']],
    ['billing hold unknown (billing service unreachable)', { billingHold: true, billingHoldUnknown: true }, ['billing_hold_unknown']],
    ['email unverified', { emailVerified: false }, ['email_unverified']],
    ['partner too young', { createdAt: hoursAgo(23) }, ['too_young']],
  ] as const)('%s', (_name, overrides, blockers) => {
    const decision = promotionDecision({ ...baseFacts(), ...overrides }, now);
    if (blockers.length === 0) expect(decision).toEqual({ promote: true, reason: 'auto:settled_card_24h' });
    else expect(decision).toEqual({ promote: false, blockers });
  });

  it('promotes at the exact 24-hour boundary when all facts are clear', () => {
    expect(promotionDecision(baseFacts(), now)).toEqual({
      promote: true, reason: 'auto:settled_card_24h',
    });
  });

  it('promotes when the partner is exactly 24 hours old', () => {
    const facts = { ...baseFacts(), createdAt: hoursAgo(24) };
    expect(promotionDecision(facts, now)).toEqual({ promote: true, reason: 'auto:settled_card_24h' });
  });

  it('blocks as too_young at 23 hours 59 minutes old', () => {
    const createdAt = new Date(now.getTime() - (23 * 60 + 59) * 60 * 1_000);
    const facts = { ...baseFacts(), createdAt };
    expect(promotionDecision(facts, now)).toEqual({ promote: false, blockers: ['too_young'] });
  });
});

describe('tryAutoPromote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBillingClient.mockImplementation(billingClient);
    closeOpenCheckouts.mockResolvedValue({ status: 'closed', expiredCheckoutSessionIds: [], canceledSubscriptionIds: [] });
    createAuditLog.mockResolvedValue(undefined);
    readTrust.mockResolvedValue({ trustState: 'probation', probationEnrollments: 0 });
    getSettledCardCharge.mockResolvedValue({
      chargeId: 'ch_1', settledAt: hoursAgo(24), paymentMethodType: 'card',
      threeDsAuthenticated: true, cardholderName: 'Ada', disputed: false, refunded: false,
    });
    // A resolved "clear" status, not null — null now means "unknown" and
    // fails closed (see the billing-hold-unknown tests below).
    getSignupRiskHold.mockResolvedValue({ status: 'none' });
    setTrustState.mockResolvedValue(true);
    execute.mockResolvedValue([hardDenyRow()]);
    hasFraudulentRefundMatch.mockResolvedValue(false);
    sendEvidenceCard.mockResolvedValue(undefined);

    select.mockImplementation((fields: Record<string, unknown>) => {
      if ('createdAt' in fields) {
        return { from: () => ({ where: () => ({ limit: async () => [{ createdAt: hoursAgo(48), emailVerifiedAt: hoursAgo(47), signupIpClass: 'residential' }] }) }) };
      }
      if ('ipClass' in fields) {
        return { from: () => ({ innerJoin: () => ({ where: async () => [{ ipClass: 'business' }] }) }) };
      }
      return { from: () => ({ where: async () => [{ count: 0 }] }) };
    });
  });

  it('promotes an eligible probation partner with its facts as evidence', async () => {
    await expect(tryAutoPromote('p1')).resolves.toBe(true);

    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'trusted', 'auto:settled_card_24h', null,
      expect.objectContaining({ settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(24) } }),
      { expectedFrom: 'probation' },
    );
    // One system context for the hard-deny query, one for the local facts.
    expect(runOutside).toHaveBeenCalledTimes(2);
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['link', { paymentMethodType: 'link' }],
    ['refunded', { refunded: true }],
    ['disputed', { disputed: true }],
    ['missing cardholder name', { cardholderName: '' }],
    ['null cardholder name', { cardholderName: null }],
    ['threeDsAuthenticated false', { threeDsAuthenticated: false }],
    ['threeDsAuthenticated null', { threeDsAuthenticated: null }],
  ])('does not promote a %s charge returned by billing', async (_name, overrides) => {
    getSettledCardCharge.mockResolvedValue({
      chargeId: 'ch_1', settledAt: hoursAgo(48), paymentMethodType: 'card',
      threeDsAuthenticated: true, cardholderName: 'Ada', disputed: false, refunded: false,
      ...overrides,
    });

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
  });

  it.each(['trusted', 'restricted'] as const)('never promotes from %s', async (trustState) => {
    readTrust.mockResolvedValue({ trustState, probationEnrollments: 0 });

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not promote when getSignupRiskHold returns null (unknown, fails closed)', async () => {
    getSignupRiskHold.mockResolvedValue(null);

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
  });

  it.each(['none', 'pass'] as const)('treats a %s risk-hold status as no hold', async (status) => {
    getSignupRiskHold.mockResolvedValue({ status });

    await expect(tryAutoPromote('p1')).resolves.toBe(true);
    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'trusted', 'auto:settled_card_24h', null,
      expect.objectContaining({ billingHold: false, billingHoldUnknown: false }),
      { expectedFrom: 'probation' },
    );
  });

  it.each(['hold', 'review_pending'] as const)('does not promote on a %s risk-hold status', async (status) => {
    getSignupRiskHold.mockResolvedValue({ status });

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
  });

  describe('hard-deny evaluation is inside tryAutoPromote', () => {
    it('restricts instead of promoting when a hard deny matches', async () => {
      execute.mockResolvedValue([hardDenyRow({ signup_ip_class: 'tor' })]);

      await expect(tryAutoPromote('p1')).resolves.toBe(false);

      expect(setTrustState).toHaveBeenCalledTimes(1);
      expect(setTrustState).toHaveBeenCalledWith(
        'p1', 'restricted', 'auto:tor_signup', null,
        { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
        { expectedFrom: 'probation' },
      );
      expect(sendEvidenceCard).toHaveBeenCalledWith('p1', 'restricted');
      // Never falls through to the promotion path.
      expect(getSettledCardCharge).not.toHaveBeenCalled();
    });

    it('does not send the evidence card when the restrict CAS loses', async () => {
      execute.mockResolvedValue([hardDenyRow({ signup_ip_class: 'tor' })]);
      setTrustState.mockResolvedValue(false);

      await expect(tryAutoPromote('p1')).resolves.toBe(false);
      expect(sendEvidenceCard).not.toHaveBeenCalled();
    });

    it('does not fail when the restricted evidence card throws (best effort)', async () => {
      execute.mockResolvedValue([hardDenyRow({ signup_ip_class: 'tor' })]);
      sendEvidenceCard.mockRejectedValue(new Error('smtp down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(tryAutoPromote('p1')).resolves.toBe(false);
      warn.mockRestore();
    });

    it('propagates a hard-deny evaluation failure rather than promoting past it', async () => {
      execute.mockRejectedValue(new Error('db exploded'));

      await expect(tryAutoPromote('p1')).rejects.toThrow('db exploded');
      expect(setTrustState).not.toHaveBeenCalled();
    });

    it('is exported for the ip-classify path, which restricts without promoting', async () => {
      execute.mockResolvedValue([hardDenyRow({ signup_ip_class: 'tor' })]);

      await expect(restrictOnHardDeny('p1')).resolves.toBe(true);
      expect(setTrustState).toHaveBeenCalledWith(
        'p1', 'restricted', 'auto:tor_signup', null,
        expect.anything(), { expectedFrom: 'probation' },
      );
    });
  });

  it('treats a CAS miss on the underlying write as "not promoted" with no audit/event', async () => {
    // setTrustState itself performs the atomic compare-and-swap (writeTrust
    // with expectedFrom); when it reports the row already moved out of
    // 'probation' (e.g. an admin restriction landed concurrently), tryAutoPromote
    // must surface that as false rather than assuming success.
    setTrustState.mockResolvedValue(false);

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'trusted', 'auto:settled_card_24h', null,
      expect.anything(),
      { expectedFrom: 'probation' },
    );
  });
});

describe('restrictOnHardDeny — closing open checkouts on an auto-restrict', () => {
  const cardTestingRow = () => hardDenyRow({
    card_testing_signal_id: 'sig-1',
    card_testing_score: 100,
    card_testing_evidence: { distinctPaymentMethods: 17, failedAttempts: 11, spanMinutes: 42.5 },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ABUSE_SIGNAL_OVERRIDES;
    getBillingClient.mockImplementation(billingClient);
    partnerTrustMode.mockReturnValue('enforce');
    sendOpsAlert.mockResolvedValue(true);
    hasFraudulentRefundMatch.mockResolvedValue(false);
    setTrustState.mockResolvedValue(true);
    sendEvidenceCard.mockResolvedValue(undefined);
    createAuditLog.mockResolvedValue(undefined);
    closeOpenCheckouts.mockResolvedValue({
      status: 'closed',
      expiredCheckoutSessionIds: ['cs_1', 'cs_2'],
      canceledSubscriptionIds: ['sub_1'],
    });
  });

  it('restricts, then expires open checkouts and records what was closed in an audit row', async () => {
    execute.mockResolvedValue([cardTestingRow()]);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'restricted', 'auto:card_testing', null,
      expect.objectContaining({ matchedAxes: ['billing.card_testing'], score: 100 }),
      { expectedFrom: 'probation' },
    );
    expect(closeOpenCheckouts).toHaveBeenCalledWith({ partnerId: 'p1', reason: 'auto:card_testing' });
    // The restriction lands before any billing call is made.
    expect(setTrustState.mock.invocationCallOrder[0]!).toBeLessThan(closeOpenCheckouts.mock.invocationCallOrder[0]!);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      orgId: null,
      actorType: 'system',
      action: 'partner.trust.checkouts_closed',
      resourceType: 'partner',
      resourceId: 'p1',
      result: 'success',
      details: {
        trigger: 'auto:card_testing',
        status: 'closed',
        expiredCheckoutSessionIds: ['cs_1', 'cs_2'],
        canceledSubscriptionIds: ['sub_1'],
      },
    }));
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    ['tor signup', { signup_ip_class: 'tor' }, 'auto:tor_signup'],
    ['card fingerprint match', { card_partner_id: 'suspended-1' }, 'auto:fraud_identity_match'],
    ['corroborated network', {
      network_partner_id: 'suspended-1', corroboration_type: 'email_domain', corroboration_value: 'example.com',
    }, 'auto:corroborated_suspended_network'],
    ['recidivist endpoint', { recidivist_partner_id: 'suspended-9' }, 'auto:recidivist_endpoint'],
  ] as const)('closes checkouts on every auto-restrict reason (%s)', async (_name, overrides, reason) => {
    execute.mockResolvedValue([hardDenyRow(overrides)]);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);
    expect(closeOpenCheckouts).toHaveBeenCalledWith({ partnerId: 'p1', reason });
  });

  it('keeps the restriction and records the failure when the billing service cannot close checkouts', async () => {
    execute.mockResolvedValue([cardTestingRow()]);
    closeOpenCheckouts.mockResolvedValue({ status: 'failed', detail: 'Billing service returned 502' });

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.checkouts_closed',
      result: 'failure',
      details: { trigger: 'auto:card_testing', status: 'failed', detail: 'Billing service returned 502' },
    }));
    // Evidence card still goes out after a billing failure.
    expect(sendEvidenceCard).toHaveBeenCalledWith('p1', 'restricted');
    // Nothing retries a failed close, so an operator is told to do it by hand.
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('checkouts not closed'),
      body: expect.stringContaining('p1'),
    }));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('alerts an operator (without a Sentry event) when the billing endpoint is unavailable', async () => {
    execute.mockResolvedValue([cardTestingRow()]);
    closeOpenCheckouts.mockResolvedValue({ status: 'unavailable', detail: 'Billing service returned 404: Not Found' });

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('unavailable'),
    }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does not fail the restriction when the ops alert throws', async () => {
    execute.mockResolvedValue([cardTestingRow()]);
    closeOpenCheckouts.mockResolvedValue({ status: 'failed', detail: 'timeout' });
    sendOpsAlert.mockRejectedValue(new Error('webhook down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);
    expect(sendEvidenceCard).toHaveBeenCalledWith('p1', 'restricted');
    warn.mockRestore();
  });

  it('restricts but never closes checkouts in shadow mode (the restriction is not enforced there)', async () => {
    execute.mockResolvedValue([cardTestingRow()]);
    partnerTrustMode.mockReturnValue('shadow');

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'restricted', 'auto:card_testing', null, expect.anything(), { expectedFrom: 'probation' },
    );
    expect(getBillingClient).not.toHaveBeenCalled();
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(sendEvidenceCard).toHaveBeenCalledWith('p1', 'restricted');
  });

  it('records a failure (and still reports the restriction) when billing is not configured', async () => {
    execute.mockResolvedValue([cardTestingRow()]);
    getBillingClient.mockImplementation(() => { throw new Error('BREEZE_BILLING_URL not configured.'); });

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.checkouts_closed',
      result: 'failure',
      details: { trigger: 'auto:card_testing', status: 'failed', detail: 'BREEZE_BILLING_URL not configured.' },
    }));
  });

  it('never touches billing when the restrict CAS loses (already moved out of probation)', async () => {
    execute.mockResolvedValue([cardTestingRow()]);
    setTrustState.mockResolvedValue(false);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(false);
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('never touches billing or trust state when nothing matches', async () => {
    execute.mockResolvedValue([hardDenyRow()]);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it.each(['trusted', 'restricted'] as const)('never touches an already-%s partner', async (trustState) => {
    execute.mockResolvedValue([{ ...cardTestingRow(), trust_state: trustState }]);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });
});

describe('gatherPromotionFacts billing hold mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBillingClient.mockImplementation(billingClient);
    getSettledCardCharge.mockResolvedValue(null);
    select.mockImplementation((fields: Record<string, unknown>) => {
      if ('createdAt' in fields) {
        return { from: () => ({ where: () => ({ limit: async () => [{ createdAt: hoursAgo(48), emailVerifiedAt: hoursAgo(47), signupIpClass: 'residential' }] }) }) };
      }
      if ('ipClass' in fields) {
        return { from: () => ({ innerJoin: () => ({ where: async () => [] }) }) };
      }
      return { from: () => ({ where: async () => [{ count: 0 }] }) };
    });
  });

  it.each([
    ['none', false, false],
    ['pass', false, false],
    ['hold', true, false],
    ['review_pending', true, false],
  ] as const)('maps status %s to billingHold=%s', async (status, billingHold, billingHoldUnknown) => {
    getSignupRiskHold.mockResolvedValue({ status });

    await expect(gatherPromotionFacts('p1')).resolves.toMatchObject({ billingHold, billingHoldUnknown });
  });

  it('fails closed when the hold status is unknown', async () => {
    getSignupRiskHold.mockResolvedValue(null);

    await expect(gatherPromotionFacts('p1')).resolves.toMatchObject({
      billingHold: true, billingHoldUnknown: true,
    });
  });

});
