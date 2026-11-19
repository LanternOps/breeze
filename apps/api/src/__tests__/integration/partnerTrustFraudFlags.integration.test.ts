/**
 * Real-Postgres proof for the billing fraud flag consumer (billing#51):
 * services/partnerTrustFraudFlags.ts driving setTrustState, the
 * partner_billing_fraud_flags ledger and the trust audit rows.
 *
 * Mocked: the breeze-billing client (the feed and consume calls, plus the
 * checkout close), and the ops-alert sender. Everything else, including the
 * row locks, the in-transaction ledger write and the audit writes, runs
 * against real Postgres.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const billing = vi.hoisted(() => ({
  listPendingFraudFlags: vi.fn(),
  consumeFraudFlag: vi.fn(),
  closeOpenCheckouts: vi.fn(),
}));
const sendOpsAlert = vi.hoisted(() => vi.fn());

vi.mock('../../services/breezeBillingClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/breezeBillingClient')>()),
  getBreezeBillingClient: () => ({
    ...billing,
    hasFraudulentRefundMatch: async () => false,
    getSettledCardCharge: async () => null,
    getSignupRiskHold: async () => null,
  }),
}));
vi.mock('../../services/opsAlerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/opsAlerts')>()),
  sendOpsAlert,
}));

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, partnerBillingFraudFlags, partners } from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import { BillingError, type BillingFraudFlag } from '../../services/breezeBillingClient';
import { setTrustState } from '../../services/partnerTrust';
import {
  loadFraudRestoreEpisodes,
  resetFraudFlagSweepStateForTests,
  restoreBillingFraudRestriction,
  runBillingFraudFlagSweep,
} from '../../services/partnerTrustFraudFlags';
import { createPartner, createUser } from './db-utils';

const ENV_KEYS = ['IS_HOSTED', 'PARTNER_TRUST_MODE', 'PARTNER_TRUST_FRAUD_FLAGS_ENABLED', 'BREEZE_BILLING_URL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** The pending feed as billing would serve it; consume removes an entry. */
let feed: BillingFraudFlag[] = [];

function flagFor(partnerId: string, over: Partial<BillingFraudFlag> = {}): BillingFraudFlag {
  return {
    id: randomUUID(),
    partnerId,
    kind: 'test_kind_a',
    restrictReason: 'auto:test_reason_a',
    stripeObjectId: `obj_test_${randomUUID().slice(0, 8)}`,
    stripeChargeId: 'chg_test_1',
    flaggedAt: new Date('2026-11-18T10:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.IS_HOSTED = 'true';
  process.env.PARTNER_TRUST_MODE = 'enforce';
  process.env.PARTNER_TRUST_FRAUD_FLAGS_ENABLED = 'true';
  process.env.BREEZE_BILLING_URL = 'http://billing.test.invalid';
  feed = [];
  resetFraudFlagSweepStateForTests();
  billing.listPendingFraudFlags.mockReset();
  billing.listPendingFraudFlags.mockImplementation(async () => ({ flags: [...feed], malformed: [] }));
  billing.consumeFraudFlag.mockReset();
  billing.consumeFraudFlag.mockImplementation(async (id: string) => {
    feed = feed.filter((f) => f.id !== id);
    return 'consumed';
  });
  billing.closeOpenCheckouts.mockReset();
  billing.closeOpenCheckouts.mockResolvedValue({ status: 'closed', expiredCheckoutSessionIds: [], canceledSubscriptionIds: [] });
  sendOpsAlert.mockReset();
  sendOpsAlert.mockResolvedValue(true);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function partnerWithTrust(trustState: PartnerTrustState) {
  const partner = await createPartner();
  await withSystemDbAccessContext(() => db.update(partners).set({ trustState, trustChangedAt: new Date(Date.now() - 60_000) })
    .where(eq(partners.id, partner.id)));
  return partner;
}

async function readPartner(partnerId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ trustState: partners.trustState, trustReason: partners.trustReason, trustChangedAt: partners.trustChangedAt })
    .from(partners).where(eq(partners.id, partnerId)));
  return row!;
}

async function auditRows(partnerId: string, action: string) {
  return withSystemDbAccessContext(() => db
    .select({ details: auditLogs.details, actorId: auditLogs.actorId })
    .from(auditLogs)
    .where(and(eq(auditLogs.resourceId, partnerId), eq(auditLogs.action, action))));
}

async function ledger(partnerId: string) {
  return withSystemDbAccessContext(() => db.select().from(partnerBillingFraudFlags)
    .where(eq(partnerBillingFraudFlags.partnerId, partnerId)));
}

describe('billing fraud flag sweep', () => {
  it.each(['trusted', 'probation'] as const)(
    'restricts a %s partner, records the ledger row with its previous state, alerts, then consumes',
    async (from) => {
      const partner = await partnerWithTrust(from);
      const flag = flagFor(partner.id);
      feed = [flag];
      const stateAtConsume: string[] = [];
      billing.consumeFraudFlag.mockImplementation(async (id: string) => {
        // Consume must come after the state write committed.
        stateAtConsume.push((await readPartner(partner.id)).trustState);
        feed = feed.filter((f) => f.id !== id);
        return 'consumed';
      });

      const result = await runBillingFraudFlagSweep();

      expect(result).toMatchObject({ restricted: 1, consumed: 1, leftPending: 0 });
      expect(await readPartner(partner.id)).toMatchObject({ trustState: 'restricted', trustReason: 'auto:test_reason_a' });
      expect(stateAtConsume).toEqual(['restricted']);
      expect(billing.consumeFraudFlag).toHaveBeenCalledWith(flag.id, 'restricted');
      const audits = await auditRows(partner.id, 'partner.trust.restricted');
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({
        from,
        to: 'restricted',
        reason: 'auto:test_reason_a',
        matchedAxes: ['billing.fraud_flag'],
        billingFraudFlagId: flag.id,
      });
      const rows = await ledger(partner.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'restricted', previousTrustState: from, billingFlagId: flag.id });
      expect(rows[0]!.effectsDoneAt).not.toBeNull();
      expect(billing.closeOpenCheckouts).toHaveBeenCalledWith({ partnerId: partner.id, reason: 'auto:test_reason_a' });
      expect(sendOpsAlert).toHaveBeenCalledTimes(1);
      expect(sendOpsAlert.mock.calls[0]![0].body).toContain('test_kind_a');
    },
  );

  it('records an already-restricted partner without a trust write', async () => {
    const partner = await partnerWithTrust('restricted');
    const flag = flagFor(partner.id);
    feed = [flag];

    await runBillingFraudFlagSweep();

    expect(billing.consumeFraudFlag).toHaveBeenCalledWith(flag.id, 'already_restricted');
    expect(await auditRows(partner.id, 'partner.trust.restricted')).toHaveLength(0);
    expect((await ledger(partner.id)).map((r) => r.outcome)).toEqual(['already_restricted']);
    expect(billing.closeOpenCheckouts).not.toHaveBeenCalled();
  });

  it('consumes a flag for a partner that is not in this region as partner_missing and alerts', async () => {
    const flag = flagFor(randomUUID());
    feed = [flag];

    await runBillingFraudFlagSweep();

    expect(billing.consumeFraudFlag).toHaveBeenCalledWith(flag.id, 'partner_missing');
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it('writes nothing and consumes nothing when the feed cannot be read', async () => {
    const partner = await partnerWithTrust('trusted');
    billing.listPendingFraudFlags.mockRejectedValue(new BillingError('BILLING_UNAVAILABLE', 'Billing service returned 500'));

    await expect(runBillingFraudFlagSweep()).rejects.toMatchObject({ code: 'BILLING_UNAVAILABLE' });

    expect((await readPartner(partner.id)).trustState).toBe('trusted');
    expect(billing.consumeFraudFlag).not.toHaveBeenCalled();
    expect(await ledger(partner.id)).toHaveLength(0);
  });

  it('finishes a flag whose consume failed on the next run without a second restriction or alert', async () => {
    const partner = await partnerWithTrust('trusted');
    const flag = flagFor(partner.id);
    feed = [flag];
    billing.consumeFraudFlag.mockRejectedValueOnce(new BillingError('BILLING_UNAVAILABLE', 'timeout'));

    await expect(runBillingFraudFlagSweep()).rejects.toMatchObject({ code: 'BILLING_UNAVAILABLE' });
    expect((await readPartner(partner.id)).trustState).toBe('restricted');
    expect(feed).toHaveLength(1);

    const second = await runBillingFraudFlagSweep();

    expect(second).toMatchObject({ consumed: 1 });
    expect(billing.consumeFraudFlag).toHaveBeenLastCalledWith(flag.id, 'restricted');
    expect(await ledger(partner.id)).toHaveLength(1);
    expect(await auditRows(partner.id, 'partner.trust.restricted')).toHaveLength(1);
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(billing.closeOpenCheckouts).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the flag is unset', { PARTNER_TRUST_FRAUD_FLAGS_ENABLED: undefined }, 'disabled'],
    ['trust is in shadow mode', { PARTNER_TRUST_MODE: 'shadow' }, 'not_enforcing'],
    ['billing is not configured', { BREEZE_BILLING_URL: undefined }, 'billing_not_configured'],
  ] as const)('does nothing when %s', async (_label, env, skipped) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const partner = await partnerWithTrust('trusted');
    feed = [flagFor(partner.id)];

    const result = await runBillingFraudFlagSweep();

    expect(result.skipped).toBe(skipped);
    expect(billing.listPendingFraudFlags).not.toHaveBeenCalled();
    expect((await readPartner(partner.id)).trustState).toBe('trusted');
  });

  it('a throwing withinWrite rolls the trust write back: no state change, no audit row', async () => {
    const partner = await partnerWithTrust('trusted');

    await expect(setTrustState(partner.id, 'restricted', 'auto:test_reason_a', null, {}, {
      expectedFrom: 'trusted',
      withinWrite: async () => { throw new Error('boom'); },
    })).rejects.toThrow('boom');

    expect((await readPartner(partner.id)).trustState).toBe('trusted');
    expect(await auditRows(partner.id, 'partner.trust.restricted')).toHaveLength(0);
  });
});

describe('restore', () => {
  async function restrictedFromFlag(from: PartnerTrustState = 'trusted') {
    const partner = await partnerWithTrust(from);
    const flag = flagFor(partner.id);
    feed = [flag];
    await runBillingFraudFlagSweep();
    const admin = await createUser({ partnerId: partner.id, email: `admin-${randomUUID()}@example.test` });
    return { partner, flag, admin };
  }

  it('returns the partner to its previous state, audits it, and suppresses the same Stripe object afterwards', async () => {
    const { partner, flag, admin } = await restrictedFromFlag('trusted');
    const episode = (await loadFraudRestoreEpisodes([partner.id])).get(partner.id)!;
    expect(episode.previousTrustState).toBe('trusted');
    expect(episode.flags).toHaveLength(1);

    const result = await restoreBillingFraudRestriction({
      partnerId: partner.id,
      actorUserId: admin.id,
      flagIds: episode.flags.map((f) => f.id),
      operatorReason: 'reviewed with the partner',
    });

    expect(result).toMatchObject({ status: 'restored', trustState: 'trusted' });
    expect((await readPartner(partner.id)).trustState).toBe('trusted');
    const audits = await auditRows(partner.id, 'partner.trust.promoted');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({
      from: 'restricted',
      to: 'trusted',
      reason: 'admin:fraud_flag_restore',
      operatorReason: 'reviewed with the partner',
      stripeObjectIds: [flag.stripeObjectId],
    });
    expect(audits[0]!.actorId).toBe(admin.id);
    expect((await ledger(partner.id))[0]).toMatchObject({ restoredBy: admin.id });
    expect(await loadFraudRestoreEpisodes([partner.id])).toEqual(new Map());

    // A later flag of another kind on the SAME object: suppressed, not restricted.
    const later = flagFor(partner.id, { kind: 'test_kind_b', restrictReason: 'auto:test_reason_b', stripeObjectId: flag.stripeObjectId });
    feed = [later];
    await runBillingFraudFlagSweep();
    expect(billing.consumeFraudFlag).toHaveBeenLastCalledWith(later.id, 'suppressed');
    expect((await readPartner(partner.id)).trustState).toBe('trusted');

    // A flag on a DIFFERENT object still restricts.
    const other = flagFor(partner.id);
    feed = [other];
    await runBillingFraudFlagSweep();
    expect(billing.consumeFraudFlag).toHaveBeenLastCalledWith(other.id, 'restricted');
    expect((await readPartner(partner.id)).trustState).toBe('restricted');
  });

  it('returns a partner restricted from probation to probation', async () => {
    const { partner, admin } = await restrictedFromFlag('probation');
    const episode = (await loadFraudRestoreEpisodes([partner.id])).get(partner.id)!;

    const result = await restoreBillingFraudRestriction({
      partnerId: partner.id, actorUserId: admin.id, flagIds: episode.flags.map((f) => f.id),
    });

    expect(result).toMatchObject({ status: 'restored', trustState: 'probation' });
    expect((await readPartner(partner.id)).trustState).toBe('probation');
  });

  it('is stale when a flag joined the restriction after the admin loaded it', async () => {
    const { partner, admin } = await restrictedFromFlag('trusted');
    const seen = (await loadFraudRestoreEpisodes([partner.id])).get(partner.id)!.flags.map((f) => f.id);
    feed = [flagFor(partner.id)];
    await runBillingFraudFlagSweep(); // recorded as already_restricted, joins the episode

    const result = await restoreBillingFraudRestriction({ partnerId: partner.id, actorUserId: admin.id, flagIds: seen });

    expect(result).toEqual({ status: 'stale' });
    expect((await readPartner(partner.id)).trustState).toBe('restricted');
    expect((await ledger(partner.id)).every((r) => r.restoredAt === null)).toBe(true);
  });

  it('is not restorable once another trust write replaced the fraud-flag restriction', async () => {
    const { partner, admin } = await restrictedFromFlag('trusted');
    const seen = (await loadFraudRestoreEpisodes([partner.id])).get(partner.id)!.flags.map((f) => f.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setTrustState(partner.id, 'restricted', 'admin:restrict', admin.id, {}, { expectedFrom: 'restricted' });

    const result = await restoreBillingFraudRestriction({ partnerId: partner.id, actorUserId: admin.id, flagIds: seen });

    expect(result).toEqual({ status: 'not_restorable' });
    expect((await readPartner(partner.id)).trustState).toBe('restricted');
  });
});

describe('partner_billing_fraud_flags RLS — system-only', () => {
  function partnerContext(partnerId: string) {
    return {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partnerId],
      userId: null,
    };
  }

  it('a partner-scoped context cannot read its own rows or insert one', async () => {
    const partner = await partnerWithTrust('trusted');
    feed = [flagFor(partner.id)];
    await runBillingFraudFlagSweep();
    expect(await ledger(partner.id)).toHaveLength(1);

    let rows: unknown[] = [];
    let readError: unknown = null;
    try {
      rows = await withDbAccessContext(partnerContext(partner.id), () => db.select({ id: partnerBillingFraudFlags.id })
        .from(partnerBillingFraudFlags).where(eq(partnerBillingFraudFlags.partnerId, partner.id)));
    } catch (error) {
      readError = error;
    }
    if (readError) expect(String((readError as { cause?: { message?: string } }).cause?.message ?? readError)).toMatch(/permission denied|row-level security/i);
    else expect(rows).toEqual([]);

    await expect(withDbAccessContext(partnerContext(partner.id), () => db.insert(partnerBillingFraudFlags).values({
      partnerId: partner.id,
      billingFlagId: randomUUID(),
      flagKind: 'test_kind_a',
      restrictReason: 'auto:test_reason_a',
      stripeObjectId: 'obj_test_forge',
      outcome: 'already_restricted',
    }))).rejects.toThrow();
  });
});
