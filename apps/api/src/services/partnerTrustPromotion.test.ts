import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpClass } from '../db/schema/orgs';
import { opsText } from './opsAlerts';

const HOSTILE = '[click](http://evil.example) `x`\n@everyone';

const {
  readTrust, setTrustState, getSettledCardCharge, getSignupRiskHold,
  hasFraudulentRefundMatch, closeOpenCheckouts, createAuditLog, getBillingClient,
  partnerTrustMode, sendOpsAlert, captureException,
  select, execute, runOutside, withSystem, sendEvidenceCard, recordPromotionBlockers,
} = vi.hoisted(() => ({
  recordPromotionBlockers: vi.fn(),
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
vi.mock('./opsAlerts', async (orig) => ({ ...(await orig<typeof import('./opsAlerts')>()), sendOpsAlert }));
vi.mock('./sentry', () => ({ captureException }));
vi.mock('./partnerTrustBlockers', () => ({ recordPromotionBlockers }));

const billingClient = () => ({
  getSettledCardCharge, getSignupRiskHold, hasFraudulentRefundMatch, closeOpenCheckouts,
});

import {
  createSuspendedAbuseSetCache, evaluateHardDenies, gatherPromotionFacts, loadSuspendedAbuseSet,
  promotionDecision, restrictOnHardDeny, SUSPENDED_SET_FAILURE_BACKOFF_MS, SUSPENDED_SET_MAX_AGE_MS, tryAutoPromote,
  type PromotionFacts,
} from './partnerTrustPromotion';

const now = new Date('2026-09-02T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1_000);
const baseFacts = (): PromotionFacts => ({
  createdAt: hoursAgo(48),
  emailVerified: true,
  settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(24) },
  signupIpClass: 'residential',
  signupIpClassSource: 'ipinfo',
  signupIpClassifiedAt: hoursAgo(47),
  ipClassifier: 'ipinfo',
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

// evaluateHardDenies runs two statements: the suspended-for-abuse set build
// (unless a set is passed in) and the per-partner evaluation. The mock routes
// each to its own result so a test of one cannot pass on the other's rows.
const SET_ROW = {
  cards: '[{"id":"sus-card","billing_card_fingerprint":"fp_1"}]',
  recent: '[{"id":"sus-recent","signup_ip":"203.0.113.5","signup_user_agent":null,"billing_card_fingerprint":null}]',
  ips: '[{"partner_id":"sus-recent","ip":"203.0.113.5","net":"203.0.113.0/24"}]',
};
const isSetQuery = (query: unknown) => renderSql(query).text.includes('WITH abuse AS MATERIALIZED');
let setRows: unknown[] = [SET_ROW];

function evaluationReturns(rows: unknown[]) {
  execute.mockImplementation(async (query: unknown) => (isSetQuery(query) ? setRows : rows));
}

function evaluationRejects(error: Error) {
  execute.mockImplementation(async (query: unknown) => {
    if (isSetQuery(query)) return setRows;
    throw error;
  });
}

const setQueries = () => execute.mock.calls.filter(([query]) => isSetQuery(query));
const evaluationQueries = () => execute.mock.calls.filter(([query]) => !isSetQuery(query));
function evaluationQuery(): unknown {
  const [call] = evaluationQueries();
  if (!call) throw new Error('no per-partner evaluation statement was executed');
  return call[0];
}

beforeEach(() => {
  setRows = [SET_ROW];
  readTrust.mockResolvedValue({ trustState: 'probation', probationEnrollments: 0 });
});

describe('evaluateHardDenies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ABUSE_SIGNAL_OVERRIDES;
    getBillingClient.mockImplementation(billingClient);
    evaluationReturns([hardDenyRow()]);
    hasFraudulentRefundMatch.mockResolvedValue(false);
  });

  it('restricts a probation partner that signed up over Tor', async () => {
    evaluationReturns([hardDenyRow({ signup_ip_class: 'tor' })]);

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
    evaluationReturns([hardDenyRow()]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
  });

  it('restricts on an IP prefix plus the same email domain and names both axes', async () => {
    evaluationReturns([hardDenyRow({
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
    evaluationReturns([hardDenyRow({ card_partner_id: 'suspended-1' })]);

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
    evaluationReturns([hardDenyRow({
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

    const { text, params } = renderSql(evaluationQuery());
    expect(text).toContain("signal_key = 'billing.card_testing'");
    expect(text).toMatch(/pas\.score >= \$/);
    expect(params).toContain(85);
    delete process.env.ABUSE_SIGNAL_OVERRIDES;
  });

  it('restricts on a remote-tool instance match with a suspended-for-abuse partner', async () => {
    evaluationReturns([hardDenyRow({ recidivist_partner_id: 'suspended-9' })]);

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

    const { text } = renderSql(evaluationQuery());
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
    evaluationReturns([hardDenyRow({
      trust_state: trustState,
      card_testing_signal_id: 'sig-1',
      card_testing_score: 100,
      card_testing_evidence: { distinctPaymentMethods: 17 },
      recidivist_partner_id: 'suspended-9',
    })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });

  describe('the suspended-for-abuse set (#11560)', () => {
    it('builds a set first and binds its three payloads into the per-partner statement', async () => {
      await evaluateHardDenies('p1');

      expect(setQueries()).toHaveLength(1);
      expect(execute.mock.calls.findIndex(([query]) => isSetQuery(query))).toBe(0);
      const { text } = renderSql(evaluationQuery());
      expect(text).toContain(`jsonb_to_recordset(${SET_ROW.cards}::jsonb)`);
      expect(text).toContain(`jsonb_to_recordset(${SET_ROW.recent}::jsonb)`);
      expect(text).toContain(`jsonb_to_recordset(${SET_ROW.ips}::jsonb)`);
      // The suspended side is no longer derived from audit_logs per partner.
      expect(text).not.toContain('audit_logs');
    });

    it('builds the set from status=suspended partners with an abuse suspension, recent = 90 days', async () => {
      await evaluateHardDenies('p1');

      const { text } = renderSql(setQueries()[0]![0]);
      expect(text).toContain("a.action = 'partner.suspended_for_abuse'");
      expect(text).toContain("a.resource_type = 'partner'");
      expect(text).toContain("WHERE p.status = 'suspended'");
      expect(text).toContain("last_abuse.at >= now() - interval '90 days' AS recent");
    });

    it.each(['trusted', 'restricted'] as const)(
      'builds no set (and runs no statement) for an already-%s partner on the single-partner path',
      async (trustState) => {
        readTrust.mockResolvedValue({ trustState, probationEnrollments: 0 });

        await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });

        expect(execute).not.toHaveBeenCalled();
        expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
      },
    );

    it('builds no set for a partner that does not exist', async () => {
      readTrust.mockResolvedValue(null);

      await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
      expect(execute).not.toHaveBeenCalled();
    });

    it('with a supplied set, leaves the probation gate to the statement (no extra read)', async () => {
      const suspendedSet = await loadSuspendedAbuseSet();
      readTrust.mockClear();

      await evaluateHardDenies('p1', { suspendedSet });

      expect(readTrust).not.toHaveBeenCalled();
      expect(renderSql(evaluationQuery()).text).toContain("WHERE id = p1 AND trust_state = 'probation'");
    });

    it('uses a supplied set without building another', async () => {
      const suspendedSet = await loadSuspendedAbuseSet();
      execute.mockClear();

      await evaluateHardDenies('p1', { suspendedSet });
      await evaluateHardDenies('p2', { suspendedSet });

      expect(setQueries()).toHaveLength(0);
      expect(evaluationQueries()).toHaveLength(2);
    });

    it('fails closed when the set cannot be built: it rejects and never evaluates', async () => {
      execute.mockImplementation(async (query: unknown) => {
        if (isSetQuery(query)) throw new Error('db exploded');
        return [hardDenyRow()];
      });

      await expect(evaluateHardDenies('p1')).rejects.toThrow('db exploded');
      expect(evaluationQueries()).toHaveLength(0);
      expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
    });

    it('rethrows a failed evaluation without the bound suspended set in the message', async () => {
      // Drizzle's DrizzleQueryError puts every bound parameter in its message;
      // here that would be the whole suspended set, logged by every caller.
      const driverError = Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014', severity: 'ERROR', routine: 'ProcessInterrupts',
      });
      // postgres.js attaches the statement's parameters to the driver error too.
      Object.defineProperty(driverError, 'parameters', { value: ['p1', SET_ROW.ips], enumerable: false });
      const drizzleError = Object.assign(
        new Error(`Failed query: WITH target AS (...)\nparams: p1,${SET_ROW.cards},${SET_ROW.recent},${SET_ROW.ips}`),
        { cause: driverError },
      );
      evaluationRejects(drizzleError);

      const error = await evaluateHardDenies('p1').then(() => null, (e: unknown) => e as Error);

      expect(error?.message).toBe(
        '[partnerTrustPromotion] hard-deny evaluation failed (57014: canceling statement due to statement timeout)',
      );
      expect(error?.message).not.toContain('203.0.113');
      expect(error?.message).not.toContain('fp_1');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('parameters');
      // Diagnostic fields survive as properties, so code-based classifiers work.
      expect(error).toMatchObject({ code: '57014', severity: 'ERROR', routine: 'ProcessInterrupts' });
    });

    it.each([
      ['no row', []],
      ['a row without payloads', [{ cards: null, recent: '[]', ips: '[]' }]],
    ])('rejects rather than treating %s as an empty set', async (_label, rows) => {
      setRows = rows;

      await expect(loadSuspendedAbuseSet()).rejects.toThrow('suspended-for-abuse set query returned no row');
      await expect(evaluateHardDenies('p1')).rejects.toThrow('suspended-for-abuse set query returned no row');
      expect(evaluationQueries()).toHaveLength(0);
    });
  });
});

describe('createSuspendedAbuseSetCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluationReturns([hardDenyRow()]);
  });

  it('reuses one set until it is max-age old, then rebuilds', async () => {
    let clock = 1_000_000;
    const cache = createSuspendedAbuseSetCache(SUSPENDED_SET_MAX_AGE_MS, () => clock);

    const first = await cache.get();
    clock += SUSPENDED_SET_MAX_AGE_MS - 1;
    expect(await cache.get()).toBe(first);
    expect(setQueries()).toHaveLength(1);

    clock += 1;
    const second = await cache.get();
    expect(second).not.toBe(first);
    expect(setQueries()).toHaveLength(2);
  });

  it('never caches a failed build as a set: rethrows it for the backoff window, then builds again', async () => {
    let clock = 1_000_000;
    const cache = createSuspendedAbuseSetCache(SUSPENDED_SET_MAX_AGE_MS, () => clock);
    execute.mockRejectedValueOnce(new Error('db exploded'));

    await expect(cache.get()).rejects.toThrow('db exploded');
    // Within the backoff: the same failure, and no second full build against
    // a database that just failed one.
    clock += SUSPENDED_SET_FAILURE_BACKOFF_MS - 1;
    await expect(cache.get()).rejects.toThrow('db exploded');
    expect(execute).toHaveBeenCalledTimes(1);

    clock += 1;
    await expect(cache.get()).resolves.toEqual(expect.objectContaining({ cardsJson: SET_ROW.cards }));
    expect(execute).toHaveBeenCalledTimes(2);
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

  describe('offline baseline (#11698)', () => {
    const offline = (overrides: Partial<PromotionFacts>) => ({
      ...baseFacts(), signupIpClass: 'unknown' as IpClass, ipClassifier: 'offline' as const,
      signupIpClassifiedAt: hoursAgo(1), ...overrides,
    });

    it('does not block on "checked, nothing found" while no keyed provider is configured', () => {
      expect(promotionDecision(offline({ signupIpClassSource: 'offline' }), now)).toEqual({
        promote: true, reason: 'auto:settled_card_24h',
      });
    });

    it.each([
      ['never classified (no source recorded)', { signupIpClassSource: null }],
      ['only the Tor list was checked', { signupIpClassSource: 'offline-partial' }],
      ['a private address (nothing checked)', { signupIpClassSource: 'none' }],
      ['a keyed provider is configured now', { signupIpClassSource: 'offline', ipClassifier: 'ipinfo' as const }],
      ['the keyed provider returned unknown', { signupIpClassSource: 'ipinfo', ipClassifier: 'ipinfo' as const }],
      ['the clear is older than its maximum age', { signupIpClassSource: 'offline', signupIpClassifiedAt: hoursAgo(49) }],
      ['the clear has no timestamp', { signupIpClassSource: 'offline', signupIpClassifiedAt: null }],
    ])('still blocks as signup_ip_unclassified when %s', (_name, overrides) => {
      expect(promotionDecision(offline(overrides), now)).toEqual({
        promote: false, blockers: ['signup_ip_unclassified'],
      });
    });

    it.each(['hosting', 'vpn', 'tor'] as const)('keeps a %s signup as a blocker', (ipClass) => {
      expect(promotionDecision(offline({ signupIpClass: ipClass, signupIpClassSource: 'offline' }), now)).toEqual({
        promote: false, blockers: ['signup_ip_hosting'],
      });
    });

    it('leaves every other blocker in place', () => {
      expect(promotionDecision(offline({
        signupIpClassSource: 'offline', settledCard: null, deviceIpClasses: ['tor'], emailVerified: false,
      }), now)).toEqual({
        promote: false, blockers: ['card_not_settled', 'device_on_tor', 'email_unverified'],
      });
    });
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
    evaluationReturns([hardDenyRow()]);
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
    // One system context each for the suspended-set build, the hard-deny
    // query and the local facts; no connection is held across them.
    expect(runOutside).toHaveBeenCalledTimes(3);
    expect(withSystem).toHaveBeenCalledTimes(3);
    expect(setQueries()).toHaveLength(1);
    expect(evaluationQueries()).toHaveLength(1);
  });

  describe('with a shared suspended set (the promote job, #11560)', () => {
    const shared = {
      loadedAt: new Date(), cardsJson: '[]', recentJson: '[]', ipsJson: '[]',
    };

    it('evaluates against the shared set, then re-checks against a fresh one before promoting', async () => {
      await expect(tryAutoPromote('p1', { suspendedSet: shared })).resolves.toBe(true);

      expect(setQueries()).toHaveLength(1);
      const [first, second] = evaluationQueries().map(([query]) => renderSql(query).text);
      expect(first).toContain(`jsonb_to_recordset(${shared.ipsJson}::jsonb)`);
      expect(second).toContain(`jsonb_to_recordset(${SET_ROW.ips}::jsonb)`);
      expect(setTrustState).toHaveBeenCalledWith(
        'p1', 'trusted', 'auto:settled_card_24h', null, expect.any(Object), { expectedFrom: 'probation' },
      );
    });

    it('does not promote when the fresh re-check restricts the partner', async () => {
      // The stale shared set has no match; the fresh one does (a partner
      // suspended for abuse after the shared set was built).
      execute.mockImplementation(async (query: unknown) => {
        if (isSetQuery(query)) return [SET_ROW];
        const { text } = renderSql(query);
        return text.includes(SET_ROW.cards)
          ? [hardDenyRow({ card_partner_id: 'sus-card' })]
          : [hardDenyRow()];
      });

      await expect(tryAutoPromote('p1', { suspendedSet: shared })).resolves.toBe(false);

      expect(setTrustState).toHaveBeenCalledTimes(1);
      expect(setTrustState).toHaveBeenCalledWith(
        'p1', 'restricted', 'auto:fraud_identity_match', null, expect.any(Object), { expectedFrom: 'probation' },
      );
      expect(setTrustState).not.toHaveBeenCalledWith('p1', 'trusted', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    });

    it('skips the fresh re-check when the partner is not promoted anyway', async () => {
      getSignupRiskHold.mockResolvedValue({ status: 'hold' });

      await expect(tryAutoPromote('p1', { suspendedSet: shared })).resolves.toBe(false);

      expect(setQueries()).toHaveLength(0);
      expect(evaluationQueries()).toHaveLength(1);
    });
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

  it('records the blockers it found so the trust queue can show them', async () => {
    getSettledCardCharge.mockResolvedValue(null);

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(recordPromotionBlockers).toHaveBeenCalledWith('p1', ['card_not_settled']);
  });

  it('still returns its decision when recording the blockers fails', async () => {
    getSettledCardCharge.mockResolvedValue(null);
    recordPromotionBlockers.mockRejectedValueOnce(new Error('redis down'));

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
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
      evaluationReturns([hardDenyRow({ signup_ip_class: 'tor' })]);

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
      evaluationReturns([hardDenyRow({ signup_ip_class: 'tor' })]);
      setTrustState.mockResolvedValue(false);

      await expect(tryAutoPromote('p1')).resolves.toBe(false);
      expect(sendEvidenceCard).not.toHaveBeenCalled();
    });

    it('does not fail when the restricted evidence card throws (best effort)', async () => {
      evaluationReturns([hardDenyRow({ signup_ip_class: 'tor' })]);
      sendEvidenceCard.mockRejectedValue(new Error('smtp down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(tryAutoPromote('p1')).resolves.toBe(false);
      warn.mockRestore();
    });

    it('propagates a hard-deny evaluation failure rather than promoting past it', async () => {
      evaluationRejects(Object.assign(new Error('db exploded'), { code: '57P01' }));

      await expect(tryAutoPromote('p1')).rejects.toThrow('57P01: db exploded');
      expect(setTrustState).not.toHaveBeenCalled();
    });

    it('is exported for the ip-classify path, which restricts without promoting', async () => {
      evaluationReturns([hardDenyRow({ signup_ip_class: 'tor' })]);

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
    evaluationReturns([cardTestingRow()]);

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
    evaluationReturns([hardDenyRow(overrides)]);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);
    expect(closeOpenCheckouts).toHaveBeenCalledWith({ partnerId: 'p1', reason });
  });

  it('keeps the restriction and records the failure when the billing service cannot close checkouts', async () => {
    evaluationReturns([cardTestingRow()]);
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

  it('escapes the billing detail in the checkouts-not-closed ops alert', async () => {
    evaluationReturns([cardTestingRow()]);
    closeOpenCheckouts.mockResolvedValue({ status: 'failed', detail: HOSTILE });
    await restrictOnHardDeny('p1');
    const { body } = sendOpsAlert.mock.calls[0]![0] as { body: string };
    expect(body).toContain(opsText(HOSTILE));
    expect(body).not.toContain('](http');
    expect(body).not.toContain('`x`');
    expect(body).not.toContain('\n@everyone');
  });

  it('alerts an operator (without a Sentry event) when the billing endpoint is unavailable', async () => {
    evaluationReturns([cardTestingRow()]);
    closeOpenCheckouts.mockResolvedValue({ status: 'unavailable', detail: 'Billing service returned 404: Not Found' });

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('unavailable'),
    }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does not fail the restriction when the ops alert throws', async () => {
    evaluationReturns([cardTestingRow()]);
    closeOpenCheckouts.mockResolvedValue({ status: 'failed', detail: 'timeout' });
    sendOpsAlert.mockRejectedValue(new Error('webhook down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);
    expect(sendEvidenceCard).toHaveBeenCalledWith('p1', 'restricted');
    warn.mockRestore();
  });

  it('restricts but never closes checkouts in shadow mode (the restriction is not enforced there)', async () => {
    evaluationReturns([cardTestingRow()]);
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
    evaluationReturns([cardTestingRow()]);
    getBillingClient.mockImplementation(() => { throw new Error('BREEZE_BILLING_URL not configured.'); });

    await expect(restrictOnHardDeny('p1')).resolves.toBe(true);

    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.checkouts_closed',
      result: 'failure',
      details: { trigger: 'auto:card_testing', status: 'failed', detail: 'BREEZE_BILLING_URL not configured.' },
    }));
  });

  it('never touches billing when the restrict CAS loses (already moved out of probation)', async () => {
    evaluationReturns([cardTestingRow()]);
    setTrustState.mockResolvedValue(false);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(false);
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('never touches billing or trust state when nothing matches', async () => {
    evaluationReturns([hardDenyRow()]);

    await expect(restrictOnHardDeny('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it.each(['trusted', 'restricted'] as const)('never touches an already-%s partner', async (trustState) => {
    evaluationReturns([{ ...cardTestingRow(), trust_state: trustState }]);

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

  it('reports the signup classification source and the active classifier', async () => {
    getSignupRiskHold.mockResolvedValue({ status: 'none' });
    select.mockImplementation((fields: Record<string, unknown>) => {
      if ('createdAt' in fields) {
        expect(fields).toHaveProperty('signupIpClassSource');
        expect(fields).toHaveProperty('signupIpClassifiedAt');
        return { from: () => ({ where: () => ({ limit: async () => [{
          createdAt: hoursAgo(48), emailVerifiedAt: hoursAgo(47), signupIpClass: 'unknown', signupIpClassSource: 'offline',
          signupIpClassifiedAt: hoursAgo(2),
        }] }) }) };
      }
      if ('ipClass' in fields) return { from: () => ({ innerJoin: () => ({ where: async () => [] }) }) };
      return { from: () => ({ where: async () => [{ count: 0 }] }) };
    });

    delete process.env.IP_CLASSIFY_PROVIDER;
    await expect(gatherPromotionFacts('p1')).resolves.toMatchObject({
      signupIpClass: 'unknown', signupIpClassSource: 'offline', signupIpClassifiedAt: hoursAgo(2), ipClassifier: 'offline',
    });
    process.env.IP_CLASSIFY_PROVIDER = 'ipdata';
    process.env.IP_CLASSIFY_API_KEY = 'k';
    try {
      await expect(gatherPromotionFacts('p1')).resolves.toMatchObject({ ipClassifier: 'ipdata' });
    } finally {
      delete process.env.IP_CLASSIFY_PROVIDER;
      delete process.env.IP_CLASSIFY_API_KEY;
    }
  });

  it('fails closed when the hold status is unknown', async () => {
    getSignupRiskHold.mockResolvedValue(null);

    await expect(gatherPromotionFacts('p1')).resolves.toMatchObject({
      billingHold: true, billingHoldUnknown: true,
    });
  });

});
