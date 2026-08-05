/**
 * Real-DB integration tests for the abuse-signals sweep's hand-written loader
 * SQL: `loadPartnerAggregates()` (heuristics.ts) and
 * `loadBillingIdentityAggregates()` (billingIdentity.ts). Both decide WHICH
 * partners get evaluated at all, and the two answer that question differently
 * on purpose — see the billing describe block.
 *
 * The heavy lifting here is a hand-written multi-CTE raw SQL query (org →
 * device joins, an org_id-NULL-attributed audit_logs branch for partner-admin
 * failed logins, and a three-armed `scoped` CTE deciding which partners get
 * evaluated at all). None of that is exercised by the mocked unit tests in
 * heuristics.test.ts, which stub PartnerAggregates directly. This test proves
 * the SQL itself against real Postgres, including the RLS angle: the query
 * MUST run inside a system DB context (bare breeze_app reads return 0 rows
 * under forced RLS) — see the heuristics.ts header comment.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, devices, auditLogs, partnerAbuseSignals } from '../../db/schema';
import { loadPartnerAggregates } from '../../services/abuseSignals/heuristics';
import {
  loadBillingIdentityAggregates,
  computeBillingIdentitySignals,
} from '../../services/abuseSignals/billingIdentity';
import { loadSignalConfig } from '../../services/abuseSignals/config';
import { createPartner, createOrganization, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

// No manual afterEach cleanup here: `partners` is TRUNCATE ... CASCADE'd by
// setup.ts's global beforeEach (cleanupDatabase), which transitively
// truncates every table with a FK back to partners (organizations, users,
// devices, partner_abuse_signals, ...) — the same isolation mechanism every
// other integration test in this directory relies on. A manual per-row
// DELETE would be unsafe here anyway: audit_logs is append-only (DELETE is
// blocked by a trigger — see 2026-05-25-a-audit-log-append-only.sql) and
// deleting `partners` directly (no ON DELETE CASCADE from organizations/
// users at the FK level) would fail with a foreign-key violation.

const DAY_MS = 24 * 60 * 60 * 1000;

function consumerHostname(index: number): string {
  // Matches the sweep's consumer-hostname regex: ^(DESKTOP|LAPTOP)-[A-Z0-9]{7}$
  return `DESKTOP-AAAA${String(index).padStart(3, '0')}`;
}

async function seedDevice(opts: { orgId: string; siteId: string; hostname: string; enrollmentIp: string; lastSeenIp?: string; enrolledAt: Date }) {
  const testDb = getTestDb();
  const [device] = await testDb
    .insert(devices)
    .values({
      orgId: opts.orgId,
      siteId: opts.siteId,
      agentId: randomUUID(),
      hostname: opts.hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
      enrollmentIp: opts.enrollmentIp,
      lastSeenIp: opts.lastSeenIp,
      enrolledAt: opts.enrolledAt,
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('seedDevice: no row returned');
  return device;
}

describe('loadPartnerAggregates (real DB)', () => {
  it('aggregates devices, consumer hostnames, 24h enrollments, 30d distinct enrollment IPs, and 24h failed logins for a young active partner', async () => {
    const partner = await createPartner({ status: 'active' });

    const now = new Date();
    const testDb = getTestDb();
    await testDb
      .update(partners)
      .set({
        createdAt: new Date(now.getTime() - 5 * DAY_MS),
        emailVerifiedAt: now,
        paymentMethodAttachedAt: now,
      })
      .where(eq(partners.id, partner.id));

    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    for (let i = 1; i <= 6; i += 1) {
      await seedDevice({
        orgId: org.id,
        siteId: site.id,
        hostname: consumerHostname(i),
        enrollmentIp: `10.0.0.${i}`,
        lastSeenIp: `10.${i}.0.1`,
        enrolledAt: now,
      });
    }

    // Partner-admin login failures land with org_id NULL, attributed to the
    // partner via the target user's partner_id (audit actor_id -> users.id).
    const adminUser = await createUser({ partnerId: partner.id });
    await testDb.insert(auditLogs).values([
      {
        orgId: null,
        actorType: 'user',
        actorId: adminUser.id,
        action: 'user.login.failed',
        resourceType: 'user',
        resourceId: adminUser.id,
        result: 'failure',
        timestamp: now,
      },
      {
        orgId: null,
        actorType: 'user',
        actorId: adminUser.id,
        action: 'user.login.failed',
        resourceType: 'user',
        resourceId: adminUser.id,
        result: 'failure',
        timestamp: now,
      },
    ]);

    const aggregates = await withSystemDbAccessContext(() => loadPartnerAggregates());
    const row = aggregates.find((a) => a.partnerId === partner.id);

    expect(row).toBeDefined();
    expect(row!.deviceCount).toBe(6);
    expect(row!.consumerHostnameCount).toBe(6);
    expect(row!.enrolled24h).toBe(6);
    expect(row!.distinctEnrollmentIps30d).toBe(6);
    expect(row!.failedLogins24h).toBe(2);
    // last_seen_ip values surface for the device_ip_scatter heuristic
    // (prefix grouping itself is pure TS, unit-tested in heuristics.test.ts).
    expect([...row!.lastSeenIps].sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((i) => `10.${i}.0.1`).sort(),
    );
  });

  it("includes an old partner with no recent enrollments when it has an OPEN partner_abuse_signals row (scoped CTE's third OR arm)", async () => {
    const partner = await createPartner({ status: 'active' });

    const now = new Date();
    const testDb = getTestDb();
    await testDb
      .update(partners)
      .set({
        createdAt: new Date(now.getTime() - 200 * DAY_MS),
        emailVerifiedAt: now,
        paymentMethodAttachedAt: now,
      })
      .where(eq(partners.id, partner.id));

    // No devices, no recent enrollments — this partner would normally fall
    // outside the `scoped` CTE's young/recently-enrolling window entirely.
    await withSystemDbAccessContext(() =>
      db.insert(partnerAbuseSignals).values({
        partnerId: partner.id,
        signalKey: 'rmm.enrollment_velocity',
        severity: 'watch',
        score: 45,
        evidence: {},
      }),
    );

    const aggregates = await withSystemDbAccessContext(() => loadPartnerAggregates());
    const row = aggregates.find((a) => a.partnerId === partner.id);

    expect(row).toBeDefined();
    expect(row!.deviceCount).toBe(0);
  });

  it('excludes a PENDING partner — RMM heuristics are device/session-shaped and structurally meaningless pre-activation', async () => {
    const partner = await createPartner({ status: 'pending' });

    const aggregates = await withSystemDbAccessContext(() => loadPartnerAggregates());

    expect(aggregates.some((a) => a.partnerId === partner.id)).toBe(false);
  });
});

/**
 * Billing-identity scope. Unlike the RMM detectors above, this one evaluates
 * 'pending' partners as well as 'active' ones: the partners.billing_* snapshot
 * is written by payment-provider webhooks independently of the signup gate, and
 * card testing is a PRE-activation act by construction — the attacker is trying
 * cards precisely because they have not got in yet, so the partner never leaves
 * 'pending'. An active-only scope made that shape permanently invisible.
 */
describe('loadBillingIdentityAggregates (real DB) — evaluated scope', () => {
  const setBillingSnapshot = async (
    partnerId: string,
    values: Partial<typeof partners.$inferInsert>,
  ) => {
    await getTestDb().update(partners).set(values).where(eq(partners.id, partnerId));
  };

  it('evaluates a PENDING partner carrying billing evidence, and fires all three billing signals', async () => {
    // Shape taken from a real US-prod account that accumulated 35 failed
    // billing attempts across 4 declined cards in one afternoon and never
    // produced a single signal, because it sat at status='pending' forever.
    const pending = await createPartner({ status: 'pending', name: 'Admintecho Widgets' });
    // A previously-suspended partner sharing the same card. It must stay in the
    // fingerprint correlation corpus (corpus rule) while never being evaluated
    // itself — that combination is the whole point of the shared-fingerprint
    // signal, and it only pays off if the NEW (still pending) signup can be
    // attributed.
    const suspended = await createPartner({ status: 'suspended', name: 'Prior Shop' });

    const now = new Date();
    const fingerprint = `fp_${randomUUID().replace(/-/g, '')}`;
    await setBillingSnapshot(pending.id, {
      billingCardholderName: 'Yevgeny Unrelated',
      billingCardFingerprint: fingerprint,
      billingDistinctPaymentMethods: 4,
      billingPaymentMethodsFirstSeenAt: new Date(now.getTime() - 11 * 60 * 1000),
      billingPaymentMethodsLastSeenAt: new Date(now.getTime() - 2 * 60 * 1000),
      billingFailedAttempts: 35,
      billingIdentitySyncedAt: now,
    });
    await setBillingSnapshot(suspended.id, { billingCardFingerprint: fingerprint });

    const result = await withSystemDbAccessContext(() => loadBillingIdentityAggregates());

    const agg = result.aggregates.find((a) => a.partnerId === pending.id);
    expect(agg).toBeDefined();
    expect(agg!.distinctPaymentMethods).toBe(4);
    expect(agg!.failedAttempts).toBe(35);
    // Scanned => open rows for this partner can stale-resolve on evidence.
    expect(result.scannedPartnerIds).toContain(pending.id);

    // Scope was widened to 'pending', NOT to already-actioned statuses.
    expect(result.aggregates.some((a) => a.partnerId === suspended.id)).toBe(false);
    // ...but the suspended partner is still in the correlation corpus.
    expect(result.sharedFingerprints.get(fingerprint)).toBe(2);

    const signals = computeBillingIdentitySignals(
      result.aggregates,
      result.sharedFingerprints,
      loadSignalConfig(),
    ).filter((s) => s.partnerId === pending.id);

    expect(signals.map((s) => s.signalKey).sort()).toEqual([
      'billing.card_testing',
      'billing.cardholder_name_mismatch',
      'billing.shared_card_fingerprint',
    ]);
    expect(signals.every((s) => s.severity === 'alert')).toBe(true);
  });

  it('keeps a PENDING partner in scope once its billing snapshot is cleared but a billing.* row is still open, so the row resolves on evidence', async () => {
    const pending = await createPartner({ status: 'pending', name: 'Cleared Snapshot Co' });

    // Snapshot cleared by the billing service: none of the first three OR arms
    // match, so only the open-signal EXISTS arm can keep this partner scoped.
    await withSystemDbAccessContext(() =>
      db.insert(partnerAbuseSignals).values({
        partnerId: pending.id,
        signalKey: 'billing.card_testing',
        severity: 'alert',
        score: 100,
        evidence: {},
      }),
    );

    const result = await withSystemDbAccessContext(() => loadBillingIdentityAggregates());

    expect(result.scannedPartnerIds).toContain(pending.id);
    // No evidence this sweep => no signal, and persistSignals will stale-resolve
    // the open row because the partner is in evaluatedPartnerIds.
    const signals = computeBillingIdentitySignals(
      result.aggregates,
      result.sharedFingerprints,
      loadSignalConfig(),
    ).filter((s) => s.partnerId === pending.id);
    expect(signals).toEqual([]);
  });
});
