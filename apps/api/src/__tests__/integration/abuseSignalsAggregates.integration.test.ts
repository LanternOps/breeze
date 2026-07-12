/**
 * Real-DB integration test for `loadPartnerAggregates()` (the abuse-signals
 * sweep's fleet-grouped aggregation query — apps/api/src/services/abuseSignals/heuristics.ts).
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

async function seedDevice(opts: { orgId: string; siteId: string; hostname: string; enrollmentIp: string; enrolledAt: Date }) {
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
});
