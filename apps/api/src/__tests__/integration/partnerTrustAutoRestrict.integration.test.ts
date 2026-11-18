/**
 * Real-Postgres proof for the behaviour-based auto-restrict axes (#11307
 * billing.card_testing, #10123 rmm.recidivist_endpoint) and for closing a
 * restricted partner's open checkouts on every auto-restrict.
 *
 * The unit suite (services/partnerTrustPromotion.test.ts) mocks db.execute, so
 * it cannot prove the new lateral joins in evaluateHardDenies actually match
 * real partner_abuse_signals / abuse_endpoint_fingerprints rows, nor that the
 * abuse sweep fires the evaluation itself. These tests drive the real sweep
 * (detectors → persistSignals → hard-deny evaluation → setTrustState → audit
 * rows) and the real restrictOnHardDeny against a real database.
 *
 * Mocked: the breeze-billing client (so no HTTP; the billing service is what
 * talks to the payment provider), the ops-alert sender and the evidence-card
 * sender. Everything else, including the SQL, setTrustState and the audit
 * writes, runs against real Postgres.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { closeOpenCheckouts } = vi.hoisted(() => ({ closeOpenCheckouts: vi.fn() }));

vi.mock('../../services/breezeBillingClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/breezeBillingClient')>()),
  getBreezeBillingClient: () => ({
    closeOpenCheckouts,
    hasFraudulentRefundMatch: async () => false,
    getSettledCardCharge: async () => null,
    getSignupRiskHold: async () => null,
  }),
}));
vi.mock('../../services/opsAlerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/opsAlerts')>()),
  sendOpsAlert: async () => false,
}));
vi.mock('../../services/partnerTrustEvidenceCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/partnerTrustEvidenceCard')>()),
  sendEvidenceCard: async () => undefined,
}));

import { db, withSystemDbAccessContext } from '../../db';
import { auditLogs, devices, partnerAbuseSignals, partners, softwareInventory } from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import { runAbuseSweep } from '../../services/abuseSignals';
import { restrictOnHardDeny } from '../../services/partnerTrustPromotion';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const ENV_KEYS = ['IS_HOSTED', 'PARTNER_TRUST_MODE', 'ABUSE_SIGNAL_OVERRIDES'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const CLOSED = {
  status: 'closed',
  expiredCheckoutSessionIds: ['cs_test_1', 'cs_test_2'],
  canceledSubscriptionIds: ['sub_test_1'],
} as const;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.IS_HOSTED = 'true';
  process.env.PARTNER_TRUST_MODE = 'enforce';
  delete process.env.ABUSE_SIGNAL_OVERRIDES;
  closeOpenCheckouts.mockReset();
  closeOpenCheckouts.mockResolvedValue(CLOSED);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function setTrust(partnerId: string, trustState: PartnerTrustState) {
  await withSystemDbAccessContext(() => db.update(partners).set({ trustState }).where(eq(partners.id, partnerId)));
}

async function readPartner(partnerId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ trustState: partners.trustState, trustReason: partners.trustReason })
    .from(partners)
    .where(eq(partners.id, partnerId)));
  return row!;
}

async function auditRows(partnerId: string, action: string) {
  return withSystemDbAccessContext(() => db
    .select({ result: auditLogs.result, details: auditLogs.details, actorType: auditLogs.actorType })
    .from(auditLogs)
    .where(and(eq(auditLogs.resourceId, partnerId), eq(auditLogs.action, action))));
}

async function openSignal(partnerId: string, signalKey: string) {
  const rows = await withSystemDbAccessContext(() => db
    .select({ score: partnerAbuseSignals.score, resolvedAt: partnerAbuseSignals.resolvedAt })
    .from(partnerAbuseSignals)
    .where(and(eq(partnerAbuseSignals.partnerId, partnerId), eq(partnerAbuseSignals.signalKey, signalKey))));
  return rows.find((r) => r.resolvedAt === null) ?? null;
}

/** Inserts an open billing.card_testing row directly (bypassing the sweep). */
async function insertCardTestingSignal(partnerId: string, score: number, opts: { resolved?: boolean } = {}) {
  await withSystemDbAccessContext(() => db.insert(partnerAbuseSignals).values({
    partnerId,
    signalKey: 'billing.card_testing',
    severity: score >= 70 ? 'alert' : 'watch',
    score,
    evidence: {
      partnerName: 'Card Tester',
      distinctPaymentMethods: 17,
      failedAttempts: 11,
      spanMinutes: 41,
      paymentMethodsFirstSeenAt: '2026-11-07T18:00:00.000Z',
      paymentMethodsLastSeenAt: '2026-11-07T18:41:00.000Z',
      identitySyncedAt: '2026-11-07T18:45:00.000Z',
    },
    resolvedAt: opts.resolved ? new Date() : null,
  }));
}

/** Billing-service snapshot of a card-testing burst: many cards inside minutes. */
async function seedCardTestingBurst(partnerId: string, opts: { methods: number; failed: number }) {
  const now = Date.now();
  await withSystemDbAccessContext(() => db.update(partners).set({
    billingDistinctPaymentMethods: opts.methods,
    billingFailedAttempts: opts.failed,
    billingPaymentMethodsFirstSeenAt: new Date(now - 41 * 60_000),
    billingPaymentMethodsLastSeenAt: new Date(now - 60_000),
    billingIdentitySyncedAt: new Date(now),
  }).where(eq(partners.id, partnerId)));
}

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

async function seedPartnerWithDevice(opts: {
  status: 'active' | 'pending' | 'suspended';
  hostname: string;
  ip: string;
  screenConnectGuid?: string;
}) {
  const partner = await createPartner({ status: opts.status });
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const testDb = getTestDb();
  const [device] = await testDb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: randomUUID(),
    hostname: opts.hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
    enrollmentIp: opts.ip,
    lastSeenIp: opts.ip,
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  if (opts.screenConnectGuid) {
    await testDb.insert(softwareInventory).values({
      deviceId: device!.id,
      orgId: org.id,
      name: `ScreenConnect Client (${opts.screenConnectGuid})`,
    });
  }
  return partner;
}

const uniqueHost = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

describe('auto-restrict on billing.card_testing (#11307) — real Postgres', () => {
  it('the sweep restricts a probation partner whose card_testing signal reaches 100, and closes its open checkouts', async () => {
    const partner = await createPartner({ status: 'pending' });
    await setTrust(partner.id, 'probation');
    await seedCardTestingBurst(partner.id, { methods: 17, failed: 11 });

    await runAbuseSweep();

    expect(await openSignal(partner.id, 'billing.card_testing')).toMatchObject({ score: 100 });
    expect(await readPartner(partner.id)).toEqual({ trustState: 'restricted', trustReason: 'auto:card_testing' });

    const [restricted] = await auditRows(partner.id, 'partner.trust.restricted');
    expect(restricted).toMatchObject({
      actorType: 'system',
      result: 'success',
      details: expect.objectContaining({
        from: 'probation',
        to: 'restricted',
        reason: 'auto:card_testing',
        matchedAxes: ['billing.card_testing'],
        score: 100,
        alertScore: 70,
        distinctPaymentMethods: 17,
        failedAttempts: 11,
      }),
    });

    expect(closeOpenCheckouts).toHaveBeenCalledTimes(1);
    expect(closeOpenCheckouts).toHaveBeenCalledWith({ partnerId: partner.id, reason: 'auto:card_testing' });
    const closed = await auditRows(partner.id, 'partner.trust.checkouts_closed');
    expect(closed).toEqual([{
      actorType: 'system',
      result: 'success',
      details: { trigger: 'auto:card_testing', ...CLOSED },
    }]);
  });

  it('leaves a promoted (trusted) partner with the same score-100 signal untouched', async () => {
    const partner = await createPartner({ status: 'active' });
    await setTrust(partner.id, 'trusted');
    await seedCardTestingBurst(partner.id, { methods: 17, failed: 11 });

    await runAbuseSweep();

    // The signal still fires for an operator to review — only the action is withheld.
    expect(await openSignal(partner.id, 'billing.card_testing')).toMatchObject({ score: 100 });
    expect((await readPartner(partner.id)).trustState).toBe('trusted');
    expect(await auditRows(partner.id, 'partner.trust.restricted')).toEqual([]);
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it('takes no action on a card_testing signal below the alert score', async () => {
    // 3 methods inside the window, no failures = base score 50 (watch tier):
    // the "debit + credit + company card" owner the issue's guard rail names.
    const partner = await createPartner({ status: 'pending' });
    await setTrust(partner.id, 'probation');
    await seedCardTestingBurst(partner.id, { methods: 3, failed: 0 });

    await runAbuseSweep();

    expect(await openSignal(partner.id, 'billing.card_testing')).toMatchObject({ score: 50 });
    expect((await readPartner(partner.id)).trustState).toBe('probation');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it('ignores a resolved card_testing signal', async () => {
    const partner = await createPartner();
    await setTrust(partner.id, 'probation');
    await insertCardTestingSignal(partner.id, 100, { resolved: true });

    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(false);
    expect((await readPartner(partner.id)).trustState).toBe('probation');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it.each([
    [70, true],
    [69, false],
  ] as const)('treats a score of %i as %s at the default alert score of 70', async (score, restricts) => {
    const partner = await createPartner();
    await setTrust(partner.id, 'probation');
    await insertCardTestingSignal(partner.id, score);

    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(restricts);
    expect((await readPartner(partner.id)).trustState).toBe(restricts ? 'restricted' : 'probation');
  });

  it('restricts in shadow mode but does not close checkouts', async () => {
    process.env.PARTNER_TRUST_MODE = 'shadow';
    const partner = await createPartner();
    await setTrust(partner.id, 'probation');
    await insertCardTestingSignal(partner.id, 100);

    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(true);

    expect((await readPartner(partner.id)).trustState).toBe('restricted');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
    expect(await auditRows(partner.id, 'partner.trust.checkouts_closed')).toEqual([]);
  });

  it('honours an overridden alert score', async () => {
    process.env.ABUSE_SIGNAL_OVERRIDES = JSON.stringify({ 'severity.alert_score': 90 });
    const partner = await createPartner();
    await setTrust(partner.id, 'probation');
    await insertCardTestingSignal(partner.id, 85);

    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(false);
    expect((await readPartner(partner.id)).trustState).toBe('probation');
  });

  it('is idempotent: a second evaluation neither re-restricts nor closes checkouts again', async () => {
    const partner = await createPartner();
    await setTrust(partner.id, 'probation');
    await insertCardTestingSignal(partner.id, 100);

    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(true);
    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(false);

    expect(closeOpenCheckouts).toHaveBeenCalledTimes(1);
    expect(await auditRows(partner.id, 'partner.trust.restricted')).toHaveLength(1);
    expect(await auditRows(partner.id, 'partner.trust.checkouts_closed')).toHaveLength(1);
  });

  it('keeps the restriction and records the failure when the billing service cannot close checkouts', async () => {
    closeOpenCheckouts.mockResolvedValue({ status: 'unavailable', detail: 'Billing service returned 404: Not Found' });
    const partner = await createPartner();
    await setTrust(partner.id, 'probation');
    await insertCardTestingSignal(partner.id, 100);

    await expect(restrictOnHardDeny(partner.id)).resolves.toBe(true);

    expect((await readPartner(partner.id)).trustState).toBe('restricted');
    expect(await auditRows(partner.id, 'partner.trust.checkouts_closed')).toEqual([{
      actorType: 'system',
      result: 'failure',
      details: {
        trigger: 'auto:card_testing',
        status: 'unavailable',
        detail: 'Billing service returned 404: Not Found',
      },
    }]);
  });
});

describe('auto-restrict on rmm.recidivist_endpoint (#10123) — real Postgres', () => {
  const GUID = 'aabbccdd11223344';

  it('the sweep restricts a probation partner sharing a remote-tool instance id with a suspended-for-abuse partner', async () => {
    const suspended = await seedPartnerWithDevice({
      status: 'suspended', hostname: uniqueHost('SUSP'), ip: '10.10.0.1', screenConnectGuid: GUID,
    });
    await markSuspendedForAbuse(suspended.id);
    const target = await seedPartnerWithDevice({
      status: 'active', hostname: uniqueHost('TGT'), ip: '10.20.0.1', screenConnectGuid: GUID,
    });
    await setTrust(target.id, 'probation');

    await runAbuseSweep();

    expect(await openSignal(target.id, 'rmm.recidivist_endpoint')).toMatchObject({ score: 100 });
    expect(await readPartner(target.id)).toEqual({ trustState: 'restricted', trustReason: 'auto:recidivist_endpoint' });
    const [restricted] = await auditRows(target.id, 'partner.trust.restricted');
    expect(restricted!.details).toEqual(expect.objectContaining({
      reason: 'auto:recidivist_endpoint',
      matchedAxes: ['remote_tool_guid', 'suspended_for_abuse'],
      matchedSuspendedPartnerId: suspended.id,
    }));
    expect(closeOpenCheckouts).toHaveBeenCalledWith({ partnerId: target.id, reason: 'auto:recidivist_endpoint' });
  });

  it('does not restrict on a match with a partner suspended for a non-abuse reason', async () => {
    await seedPartnerWithDevice({
      status: 'suspended', hostname: uniqueHost('SUSP'), ip: '10.10.0.2', screenConnectGuid: GUID,
    });
    const target = await seedPartnerWithDevice({
      status: 'active', hostname: uniqueHost('TGT'), ip: '10.20.0.2', screenConnectGuid: GUID,
    });
    await setTrust(target.id, 'probation');

    await runAbuseSweep();

    // The detector still fires (any non-active counterpart) for human review.
    expect(await openSignal(target.id, 'rmm.recidivist_endpoint')).toMatchObject({ score: 100 });
    expect((await readPartner(target.id)).trustState).toBe('probation');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it('does not restrict on an alert-level hostname + egress-IP match without a shared instance id', async () => {
    const hostname = uniqueHost('SHAREDBOX');
    const suspended = await seedPartnerWithDevice({ status: 'suspended', hostname, ip: '10.30.0.9' });
    await markSuspendedForAbuse(suspended.id);
    const target = await seedPartnerWithDevice({ status: 'active', hostname, ip: '10.30.0.9' });
    await setTrust(target.id, 'probation');

    await runAbuseSweep();

    const signal = await openSignal(target.id, 'rmm.recidivist_endpoint');
    expect(signal?.score ?? 0).toBeGreaterThanOrEqual(70);
    expect((await readPartner(target.id)).trustState).toBe('probation');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it('does not restrict on a match with a partner suspended for abuse more than 90 days ago', async () => {
    const suspended = await seedPartnerWithDevice({
      status: 'suspended', hostname: uniqueHost('SUSP'), ip: '10.10.0.4', screenConnectGuid: GUID,
    });
    await markSuspendedForAbuse(suspended.id, new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000));
    const target = await seedPartnerWithDevice({
      status: 'active', hostname: uniqueHost('TGT'), ip: '10.20.0.4', screenConnectGuid: GUID,
    });
    await setTrust(target.id, 'probation');

    await runAbuseSweep();

    expect(await openSignal(target.id, 'rmm.recidivist_endpoint')).toMatchObject({ score: 100 });
    expect((await readPartner(target.id)).trustState).toBe('probation');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it('ignores an instance-id match once the recidivist signal is resolved', async () => {
    const suspended = await seedPartnerWithDevice({
      status: 'suspended', hostname: uniqueHost('SUSP'), ip: '10.10.0.5', screenConnectGuid: GUID,
    });
    await markSuspendedForAbuse(suspended.id);
    const target = await seedPartnerWithDevice({
      status: 'active', hostname: uniqueHost('TGT'), ip: '10.20.0.5', screenConnectGuid: GUID,
    });
    await setTrust(target.id, 'trusted');
    await runAbuseSweep(); // opens the signal without restricting (trusted)
    await withSystemDbAccessContext(() => db.update(partnerAbuseSignals)
      .set({ resolvedAt: new Date() })
      .where(eq(partnerAbuseSignals.partnerId, target.id)));
    await setTrust(target.id, 'probation');

    await expect(restrictOnHardDeny(target.id)).resolves.toBe(false);
    expect((await readPartner(target.id)).trustState).toBe('probation');
  });

  it('leaves a trusted partner with the same instance-id match untouched', async () => {
    const suspended = await seedPartnerWithDevice({
      status: 'suspended', hostname: uniqueHost('SUSP'), ip: '10.10.0.3', screenConnectGuid: GUID,
    });
    await markSuspendedForAbuse(suspended.id);
    const target = await seedPartnerWithDevice({
      status: 'active', hostname: uniqueHost('TGT'), ip: '10.20.0.3', screenConnectGuid: GUID,
    });
    await setTrust(target.id, 'trusted');

    await runAbuseSweep();

    expect(await openSignal(target.id, 'rmm.recidivist_endpoint')).toMatchObject({ score: 100 });
    expect((await readPartner(target.id)).trustState).toBe('trusted');
    expect(closeOpenCheckouts).not.toHaveBeenCalled();
  });
});
