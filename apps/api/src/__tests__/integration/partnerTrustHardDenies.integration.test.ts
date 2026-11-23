/**
 * Real-Postgres proof for evaluateHardDenies (Task 5.3 fix round 1).
 *
 * The unit suite (services/partnerTrustPromotion.test.ts) mocks db.execute
 * entirely, so it can't catch a bug in the raw SQL itself — which is exactly
 * where two CRITICAL issues were found in review: the suspended-partner joins
 * never excluded the target partner from matching itself, and the
 * email-domain corroboration axis treated a shared free-mail domain
 * (gmail.com, etc.) as identity. This suite runs the real query against a
 * real database to prove both fixes and pin the intended axis semantics.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { abuseEndpointFingerprints, auditLogs, devices, partnerAbuseSignals, partners } from '../../db/schema';
import type { IpClass, PartnerTrustState } from '../../db/schema/orgs';
import {
  evaluateHardDenies,
  loadSuspendedAbuseSet,
  type HardDenyDecision,
} from '../../services/partnerTrustPromotion';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function setPartnerFields(partnerId: string, fields: {
  trustState?: PartnerTrustState;
  signupIp?: string;
  signupIpClass?: IpClass;
  billingCardFingerprint?: string | null;
  signupUserAgent?: string | null;
}) {
  if (Object.values(fields).every((value) => value === undefined)) return;
  await withSystemDbAccessContext(() => db
    .update(partners)
    .set(fields)
    .where(eq(partners.id, partnerId)));
}

/** Records the audit-log row evaluateHardDenies looks for to identify a
 * partner as "suspended for abuse" within the last 90 days. */
async function markSuspendedForAbuse(partnerId: string, timestamp: Date = new Date()) {
  await withSystemDbAccessContext(() => db.insert(auditLogs).values({
    orgId: null,
    timestamp,
    actorType: 'system',
    actorId: randomUUID(),
    actorEmail: null,
    action: 'partner.suspended_for_abuse',
    resourceType: 'partner',
    resourceId: partnerId,
    result: 'success',
  }));
}

describe('evaluateHardDenies — real Postgres (Task 5.3 fix round 1)', () => {
  runDb('restricts a probation partner that signed up over Tor', async () => {
    const partner = await createPartner();
    await setPartnerFields(partner.id, { trustState: 'probation', signupIpClass: 'tor' });

    const decision = await evaluateHardDenies(partner.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
    });
  });

  runDb('does not restrict on a shared /24 with a suspended-for-abuse partner alone', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '203.0.113.5' });
    await markSuspendedForAbuse(suspended.id);

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '203.0.113.240', // same /24 as 203.0.113.5, no other axis
    });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({ restrict: false });
  });

  runDb('restricts on a shared /24 plus a shared non-free-mail domain, naming both axes', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '203.0.113.5' });
    await markSuspendedForAbuse(suspended.id);
    await createUser({ partnerId: suspended.id, email: 'bob@example.com' });

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '203.0.113.240',
    });
    await createUser({ partnerId: target.id, email: 'alice@example.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: {
        matchedAxes: ['network_prefix', 'email_domain'],
        matchedSuspendedPartnerId: suspended.id,
        network: {
          candidateIp: '203.0.113.240',
          suspendedIp: '203.0.113.5',
          prefixLength: 24,
        },
        corroboration: { type: 'email_domain', value: 'example.com' },
      },
    });
  });

  runDb('does not restrict on a shared /24 plus both sides sharing gmail.com', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '203.0.113.5' });
    await markSuspendedForAbuse(suspended.id);
    await createUser({ partnerId: suspended.id, email: 'bob@gmail.com' });

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '203.0.113.240',
    });
    await createUser({ partnerId: target.id, email: 'alice@gmail.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({ restrict: false });
  });

  runDb('restricts on a shared billing card fingerprint with a suspended-for-abuse partner', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { billingCardFingerprint: 'fp_shared_card_1' });
    await markSuspendedForAbuse(suspended.id);

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      billingCardFingerprint: 'fp_shared_card_1',
    });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: {
        matchedAxes: ['billing_card_fingerprint', 'suspended_for_abuse'],
        matchedSuspendedPartnerId: suspended.id,
      },
    });
  });

  runDb('never treats a partner that suspended itself as its own corroborating match', async () => {
    // The target is, unusually, both trust_state='probation' and
    // status='suspended' with its own abuse audit-log row — every axis
    // (card fingerprint, network /24, email domain) trivially "matches"
    // itself unless the query explicitly excludes s.id = t.id.
    const target = await createPartner({ status: 'suspended' });
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '198.51.100.50',
      billingCardFingerprint: 'fp_self_match',
    });
    await markSuspendedForAbuse(target.id);
    await createUser({ partnerId: target.id, email: 'self@example.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({ restrict: false });
  });

  runDb('restricts on an IPv6 /64 match plus a shared non-free-mail domain', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '2001:db8:1234:5678::99' });
    await markSuspendedForAbuse(suspended.id);
    await createUser({ partnerId: suspended.id, email: 'bob@example.com' });

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '2001:db8:1234:5678::10', // same /64 as suspended's IPv6
    });
    await createUser({ partnerId: target.id, email: 'alice@example.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: {
        matchedAxes: ['network_prefix', 'email_domain'],
        matchedSuspendedPartnerId: suspended.id,
        network: {
          candidateIp: '2001:db8:1234:5678::10',
          suspendedIp: '2001:db8:1234:5678::99',
          prefixLength: 64,
        },
        corroboration: { type: 'email_domain', value: 'example.com' },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// #11560: the promote job builds the suspended-for-abuse side once and
// evaluates every probation partner against it. These scenarios pin each
// hard-deny axis to a literal decision (written and run green against the
// per-call query before the change), then prove the shared-set path and the
// single-partner path agree with those literals for every partner in one
// populated database — so a wrong set build (a missing population, a narrowed
// window, a dropped device IP) cannot hide behind "both paths agree".
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

async function addDevice(partnerId: string, opts: { hostname: string; enrollmentIp: string | null }) {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: randomUUID(),
    hostname: opts.hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
    enrollmentIp: opts.enrollmentIp,
    enrolledAt: new Date(),
  });
}

async function addRemoteToolGuid(partnerId: string, value: string) {
  await withSystemDbAccessContext(() => db.insert(abuseEndpointFingerprints).values({
    partnerId, kind: 'remote_tool_guid', value,
  }));
}

async function addOpenSignal(
  partnerId: string,
  signalKey: string,
  score: number,
  evidence: Record<string, unknown> = {},
  opts: { resolved?: boolean } = {},
) {
  await withSystemDbAccessContext(() => db.insert(partnerAbuseSignals).values({
    partnerId, signalKey, severity: 'alert', score, evidence, resolvedAt: opts.resolved ? new Date() : null,
  }));
}

/**
 * A partner on the suspended side: status `suspended` plus the abuse audit row
 * by default. `suspendedAt: null` skips the audit row (suspended for another
 * reason); `status: 'active'` models a reinstated partner.
 */
async function suspendedPartner(opts: {
  suspendedAt?: Date | null;
  status?: 'suspended' | 'active';
  signupIp?: string;
  signupUserAgent?: string;
  billingCardFingerprint?: string;
  email?: string;
}) {
  const partner = await createPartner({ status: opts.status ?? 'suspended' });
  await setPartnerFields(partner.id, {
    signupIp: opts.signupIp,
    signupUserAgent: opts.signupUserAgent,
    billingCardFingerprint: opts.billingCardFingerprint,
  });
  if (opts.suspendedAt !== null) await markSuspendedForAbuse(partner.id, opts.suspendedAt ?? new Date());
  if (opts.email) await createUser({ partnerId: partner.id, email: opts.email });
  return partner.id;
}

async function probationPartner(opts: {
  trustState?: PartnerTrustState;
  signupIp?: string;
  signupIpClass?: IpClass;
  signupUserAgent?: string;
  billingCardFingerprint?: string;
  email?: string;
} = {}) {
  const partner = await createPartner();
  await setPartnerFields(partner.id, {
    trustState: opts.trustState ?? 'probation',
    signupIpClass: opts.signupIpClass ?? 'residential',
    signupIp: opts.signupIp,
    signupUserAgent: opts.signupUserAgent,
    billingCardFingerprint: opts.billingCardFingerprint,
  });
  if (opts.email) await createUser({ partnerId: partner.id, email: opts.email });
  return partner.id;
}

const TOR_DECISION: HardDenyDecision = {
  restrict: true,
  reason: 'auto:tor_signup',
  evidence: { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
};

const NO_RESTRICT: HardDenyDecision = { restrict: false };

const cardDecision = (suspendedId: string): HardDenyDecision => ({
  restrict: true,
  reason: 'auto:fraud_identity_match',
  evidence: { matchedAxes: ['billing_card_fingerprint', 'suspended_for_abuse'], matchedSuspendedPartnerId: suspendedId },
});

const networkDecision = (
  suspendedId: string,
  candidateIp: string,
  suspendedIp: string,
  corroboration: { type: string; value: string },
  prefixLength: 24 | 64 = 24,
): HardDenyDecision => ({
  restrict: true,
  reason: 'auto:corroborated_suspended_network',
  evidence: {
    matchedAxes: ['network_prefix', corroboration.type],
    matchedSuspendedPartnerId: suspendedId,
    network: { candidateIp, suspendedIp, prefixLength },
    corroboration,
  },
});

type Scenario = { name: string; partnerId: string; expected: HardDenyDecision };

/**
 * One database holding every axis at once, each scenario on its own /24,
 * email domain, card fingerprint, user agent, hostname prefix and remote-tool
 * id so scenarios cannot corroborate each other. Shared on purpose: the
 * batched path evaluates many partners against one set, so cross-partner
 * leakage in that set has to be visible here.
 */
async function seedWorld(): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  const add = (name: string, partnerId: string, expected: HardDenyDecision) => {
    scenarios.push({ name, partnerId, expected });
  };

  add('tor signup', await probationPartner({ signupIpClass: 'tor' }), TOR_DECISION);

  // The card axis has no window: a suspension 200 days old still counts.
  const oldCard = await suspendedPartner({ suspendedAt: daysAgo(200), billingCardFingerprint: 'fp_w_old' });
  add('card vs a suspension older than 90 days',
    await probationPartner({ billingCardFingerprint: 'fp_w_old' }), cardDecision(oldCard));

  await suspendedPartner({ suspendedAt: null, billingCardFingerprint: 'fp_w_nonabuse' });
  add('card vs a partner suspended for a non-abuse reason',
    await probationPartner({ billingCardFingerprint: 'fp_w_nonabuse' }), NO_RESTRICT);

  await suspendedPartner({ status: 'active', billingCardFingerprint: 'fp_w_reinstated' });
  add('card vs a reinstated (no longer suspended) partner',
    await probationPartner({ billingCardFingerprint: 'fp_w_reinstated' }), NO_RESTRICT);

  const inWindow = await suspendedPartner({ suspendedAt: daysAgo(89), signupIp: '198.18.1.5', email: 'x@in-window.test' });
  add('network + email, suspension 89 days ago',
    await probationPartner({ signupIp: '198.18.1.77', email: 'y@in-window.test' }),
    networkDecision(inWindow, '198.18.1.77', '198.18.1.5', { type: 'email_domain', value: 'in-window.test' }));

  await suspendedPartner({ suspendedAt: daysAgo(91), signupIp: '198.18.2.5', email: 'x@out-window.test' });
  add('network + email, suspension 91 days ago',
    await probationPartner({ signupIp: '198.18.2.77', email: 'y@out-window.test' }), NO_RESTRICT);

  const tDevice = await suspendedPartner({ signupIp: '198.18.3.5', email: 'x@dev-t.test' });
  const tDeviceTarget = await probationPartner({ signupIp: '198.18.240.1', email: 'y@dev-t.test' });
  await addDevice(tDeviceTarget, { hostname: 'tdvtgt-01', enrollmentIp: '198.18.3.200' });
  add('network via the target device enrollment IP', tDeviceTarget,
    networkDecision(tDevice, '198.18.3.200', '198.18.3.5', { type: 'email_domain', value: 'dev-t.test' }));

  const sDevice = await suspendedPartner({ email: 'x@dev-s.test' });
  await addDevice(sDevice, { hostname: 'sdvsus-01', enrollmentIp: '198.18.4.9' });
  add('network via the suspended partner device enrollment IP',
    await probationPartner({ signupIp: '198.18.4.100', email: 'y@dev-s.test' }),
    networkDecision(sDevice, '198.18.4.100', '198.18.4.9', { type: 'email_domain', value: 'dev-s.test' }));

  const uaHost = await suspendedPartner({ signupIp: '198.18.5.5', signupUserAgent: 'UA-world-host' });
  await addDevice(uaHost, { hostname: 'QXHOST-SUSP', enrollmentIp: '198.18.241.1' });
  const uaHostTarget = await probationPartner({ signupIp: '198.18.5.6', signupUserAgent: 'UA-world-host' });
  await addDevice(uaHostTarget, { hostname: 'qxhost-tgt', enrollmentIp: '198.18.242.1' });
  add('network + user agent + hostname prefix', uaHostTarget,
    networkDecision(uaHost, '198.18.5.6', '198.18.5.5', { type: 'signup_user_agent_hostname_prefix', value: 'qxhost' }));

  const uaOnly = await suspendedPartner({ signupIp: '198.18.6.5', signupUserAgent: 'UA-world-only' });
  await addDevice(uaOnly, { hostname: 'AAAAAA-SUSP', enrollmentIp: '198.18.243.1' });
  const uaOnlyTarget = await probationPartner({ signupIp: '198.18.6.6', signupUserAgent: 'UA-world-only' });
  await addDevice(uaOnlyTarget, { hostname: 'BBBBBB-TGT', enrollmentIp: '198.18.244.1' });
  add('network + user agent without a hostname prefix match', uaOnlyTarget, NO_RESTRICT);

  // Several suspended matches on the network axis: the lowest suspended id
  // wins, then the lowest candidate IP.
  const netA = await suspendedPartner({ signupIp: '198.18.7.5', email: 'x@multi-net.test' });
  const netB = await suspendedPartner({ signupIp: '198.18.7.6', email: 'z@multi-net.test' });
  const multiNetTarget = await probationPartner({ signupIp: '198.18.7.50', email: 'y@multi-net.test' });
  await addDevice(multiNetTarget, { hostname: 'mnettg-01', enrollmentIp: '198.18.7.20' });
  const netWinner = [netA, netB].sort()[0]!;
  add('network, several suspended matches', multiNetTarget,
    networkDecision(netWinner, '198.18.7.20', netWinner === netA ? '198.18.7.5' : '198.18.7.6',
      { type: 'email_domain', value: 'multi-net.test' }));

  const cardA = await suspendedPartner({ billingCardFingerprint: 'fp_w_multi' });
  const cardB = await suspendedPartner({ suspendedAt: daysAgo(300), billingCardFingerprint: 'fp_w_multi' });
  add('card, several suspended matches',
    await probationPartner({ billingCardFingerprint: 'fp_w_multi' }), cardDecision([cardA, cardB].sort()[0]!));

  const both = await suspendedPartner({ signupIp: '198.18.8.5', email: 'x@both.test', billingCardFingerprint: 'fp_w_both' });
  add('card takes precedence over network',
    await probationPartner({ signupIp: '198.18.8.6', email: 'y@both.test', billingCardFingerprint: 'fp_w_both' }),
    cardDecision(both));

  await suspendedPartner({ billingCardFingerprint: 'fp_w_tor' });
  add('tor takes precedence over card',
    await probationPartner({ signupIpClass: 'tor', billingCardFingerprint: 'fp_w_tor' }), TOR_DECISION);

  const recidivist = await suspendedPartner({});
  await addRemoteToolGuid(recidivist, 'guid-world-r');
  const recidivistTarget = await probationPartner();
  await addRemoteToolGuid(recidivistTarget, 'guid-world-r');
  await addOpenSignal(recidivistTarget, 'rmm.recidivist_endpoint', 100);
  add('recidivist remote-tool id + open signal', recidivistTarget, {
    restrict: true,
    reason: 'auto:recidivist_endpoint',
    evidence: { matchedAxes: ['remote_tool_guid', 'suspended_for_abuse'], matchedSuspendedPartnerId: recidivist },
  });

  const oldRecidivist = await suspendedPartner({ suspendedAt: daysAgo(120) });
  await addRemoteToolGuid(oldRecidivist, 'guid-world-old');
  const oldRecidivistTarget = await probationPartner();
  await addRemoteToolGuid(oldRecidivistTarget, 'guid-world-old');
  await addOpenSignal(oldRecidivistTarget, 'rmm.recidivist_endpoint', 100);
  add('recidivist vs a suspension older than 90 days', oldRecidivistTarget, NO_RESTRICT);

  const noSignal = await suspendedPartner({});
  await addRemoteToolGuid(noSignal, 'guid-world-nosig');
  const noSignalTarget = await probationPartner();
  await addRemoteToolGuid(noSignalTarget, 'guid-world-nosig');
  add('recidivist remote-tool id without an open signal', noSignalTarget, NO_RESTRICT);

  const cardTesting = await probationPartner();
  await addOpenSignal(cardTesting, 'billing.card_testing', 100, {
    partnerName: 'not copied', distinctPaymentMethods: 17, failedAttempts: 11, spanMinutes: 41,
  });
  const [signal] = await withSystemDbAccessContext(() => db
    .select({ id: partnerAbuseSignals.id })
    .from(partnerAbuseSignals)
    .where(eq(partnerAbuseSignals.partnerId, cardTesting)));
  add('open card_testing signal', cardTesting, {
    restrict: true,
    reason: 'auto:card_testing',
    evidence: {
      matchedAxes: ['billing.card_testing'],
      signalId: signal!.id,
      score: 100,
      alertScore: 70,
      distinctPaymentMethods: 17,
      failedAttempts: 11,
      spanMinutes: 41,
    },
  });

  await suspendedPartner({ billingCardFingerprint: 'fp_w_trusted' });
  add('a trusted partner is never evaluated',
    await probationPartner({ trustState: 'trusted', billingCardFingerprint: 'fp_w_trusted' }), NO_RESTRICT);

  add('a clean probation partner',
    await probationPartner({ signupIp: '198.18.9.9', email: 'clean@clean-world.test' }), NO_RESTRICT);

  // Network boundaries: the prefix really is /24 (IPv4) and /64 (IPv6).
  await suspendedPartner({ signupIp: '198.18.10.5', email: 'x@adjacent.test' });
  add('network + email in the adjacent /24',
    await probationPartner({ signupIp: '198.18.11.5', email: 'y@adjacent.test' }), NO_RESTRICT);

  const v6 = await suspendedPartner({ signupIp: '2001:db8:aa:1::5', email: 'x@v6-world.test' });
  add('network + email, same IPv6 /64',
    await probationPartner({ signupIp: '2001:db8:aa:1::77', email: 'y@v6-world.test' }),
    networkDecision(v6, '2001:db8:aa:1::77', '2001:db8:aa:1::5', { type: 'email_domain', value: 'v6-world.test' }, 64));

  await suspendedPartner({ signupIp: '2001:db8:aa:2::5', email: 'x@v6-adjacent.test' });
  add('network + email in the adjacent IPv6 /64',
    await probationPartner({ signupIp: '2001:db8:aa:3::5', email: 'y@v6-adjacent.test' }), NO_RESTRICT);

  // A partner that is itself on the suspended side never matches itself.
  const self = await createPartner({ status: 'suspended' });
  await setPartnerFields(self.id, {
    trustState: 'probation', signupIpClass: 'residential', signupIp: '198.18.12.5', billingCardFingerprint: 'fp_w_self',
  });
  await markSuspendedForAbuse(self.id);
  await createUser({ partnerId: self.id, email: 'self@self-world.test' });
  add('a probation partner that is itself suspended for abuse', self.id, NO_RESTRICT);

  await suspendedPartner({ signupIp: '198.18.13.5', email: 'x-world@gmail.com' });
  add('network + a shared free-mail domain',
    await probationPartner({ signupIp: '198.18.13.6', email: 'y-world@gmail.com' }), NO_RESTRICT);

  const caseDomain = await suspendedPartner({ signupIp: '198.18.14.5', email: 'x@Case-World.test' });
  add('network + email domain differing only in case',
    await probationPartner({ signupIp: '198.18.14.6', email: 'y@case-world.test' }),
    networkDecision(caseDomain, '198.18.14.6', '198.18.14.5', { type: 'email_domain', value: 'case-world.test' }));

  // An old abuse suspension plus a recent one: still recent.
  const mixed = await suspendedPartner({ suspendedAt: daysAgo(10), signupIp: '198.18.15.5', email: 'x@mixed-audit.test' });
  await markSuspendedForAbuse(mixed, daysAgo(200));
  add('network + email, suspended 200 and again 10 days ago',
    await probationPartner({ signupIp: '198.18.15.6', email: 'y@mixed-audit.test' }),
    networkDecision(mixed, '198.18.15.6', '198.18.15.5', { type: 'email_domain', value: 'mixed-audit.test' }));

  // Alert-score boundary and resolved signals.
  const lowCardTesting = await probationPartner();
  await addOpenSignal(lowCardTesting, 'billing.card_testing', 69);
  add('card_testing signal just below the alert score', lowCardTesting, NO_RESTRICT);

  const resolvedCardTesting = await probationPartner();
  await addOpenSignal(resolvedCardTesting, 'billing.card_testing', 100, {}, { resolved: true });
  add('resolved card_testing signal', resolvedCardTesting, NO_RESTRICT);

  const lowRecidivist = await suspendedPartner({});
  await addRemoteToolGuid(lowRecidivist, 'guid-world-low');
  const lowRecidivistTarget = await probationPartner();
  await addRemoteToolGuid(lowRecidivistTarget, 'guid-world-low');
  await addOpenSignal(lowRecidivistTarget, 'rmm.recidivist_endpoint', 69);
  add('recidivist signal just below the alert score', lowRecidivistTarget, NO_RESTRICT);

  return scenarios;
}

describe('evaluateHardDenies — every axis in one populated database (#11560)', () => {
  runDb('returns the pinned decision for every scenario (single-partner path)', async () => {
    const scenarios = await seedWorld();
    for (const scenario of scenarios) {
      expect({ name: scenario.name, decision: await evaluateHardDenies(scenario.partnerId) })
        .toEqual({ name: scenario.name, decision: scenario.expected });
    }
  });

  runDb('a suspended set built once returns the same decisions as the single-partner path', async () => {
    const scenarios = await seedWorld();
    const suspendedSet = await loadSuspendedAbuseSet();
    for (const scenario of scenarios) {
      const batched = await evaluateHardDenies(scenario.partnerId, { suspendedSet });
      const single = await evaluateHardDenies(scenario.partnerId);
      expect({ name: scenario.name, batched, single })
        .toEqual({ name: scenario.name, batched: scenario.expected, single: scenario.expected });
    }
  });

  runDb('a set built before a new abuse suspension misses it; a fresh evaluation does not', async () => {
    // This is the staleness tryAutoPromote's fresh re-check before `trusted`
    // exists for: the shared set is a snapshot.
    const stale = await loadSuspendedAbuseSet();
    const late = await suspendedPartner({ billingCardFingerprint: 'fp_w_late' });
    const target = await probationPartner({ billingCardFingerprint: 'fp_w_late' });

    expect(await evaluateHardDenies(target, { suspendedSet: stale })).toEqual(NO_RESTRICT);
    expect(await evaluateHardDenies(target)).toEqual(cardDecision(late));
    expect(await evaluateHardDenies(target, { suspendedSet: await loadSuspendedAbuseSet() })).toEqual(cardDecision(late));
  });
});
