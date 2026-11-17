/**
 * Wisp W05a (#9911) — services/wisp/watches.ts against real Postgres.
 *
 * The scheduler-facing functions (`claimDueWatches`,
 * `stopWatchesForInactiveGrants`) are raw SQL; the unit test only checks them
 * against a mock. This file runs them for real: the due-claim advances
 * `next_due_at` by cadence in one statement, a paused grant's watches stop
 * with `stopped_reason = 'paused'` (the literal W02's userResumeGrant keys
 * on), the partner admin is told once per grant, a user-paused grant tells
 * nobody, and the per-grant cap holds under concurrent creates.
 */
import { getTestDb } from './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts, deviceVulnerabilities, securityPostureSnapshots, userNotifications, vulnerabilities, wispGrantRevisions, wispGrants, wispWatches,
} from '../../db/schema';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import {
  claimDueWatches,
  createWatch,
  recordWatchHits,
  stopWatchesForInactiveGrants,
  WATCH_MAX_PER_GRANT,
  WatchLimitReachedError,
} from '../../services/wisp/watches';
import { evaluateWatchHits } from '../../services/wisp/watchHits';
import {
  assignUserToPartner, createDevice, createOrganization, createPartner, createRole, createSite, createUser,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[]) {
  return asSystem(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId, revision: 1,
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds, siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    return { grantId: grant!.id, revisionId: revision!.id };
  });
}

function ceilingFor(g: { grantId: string; revisionId: string }, partnerId: string, grantorUserId: string, orgIds: string[]): GrantCeiling {
  return {
    grantId: g.grantId, revisionId: g.revisionId, partnerId, grantorUserId,
    scopeOrgId: null, partnerWide: true, orgIds: new Set(orgIds), siteIds: null,
    permissionKeys: new Set(['ai_sessions:use']), toolAllowlist: null, deniedTools: new Set(),
    orgTerms: new Map(), status: 'active',
  };
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-watch-grantor-${randomUUID()}@wisp.test` });
  const admin = await createUser({ partnerId: partner.id, email: `wisp-watch-admin-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await assignUserToPartner(admin.id, partner.id, role!.id, 'all');
  const grant = await seedGrant(partner.id, grantor.id, [org.id]);
  return { partnerId: partner.id, orgId: org.id, grantorId: grantor.id, adminId: admin.id, grant, ceiling: ceilingFor(grant, partner.id, grantor.id, [org.id]) };
}

const orphanNotices = (userId: string, grantId: string) => asSystem(() => db.select().from(userNotifications)
  .where(and(eq(userNotifications.userId, userId), eq(userNotifications.dedupeKey, `wisp-watches-orphaned-${grantId}-${new Date().toISOString().slice(0, 10)}`))));

describe('wisp watches (real Postgres)', () => {
  it('claimDueWatches claims only due active rows and advances next_due_at by cadence', async () => {
    const f = await seed();
    const past = new Date(Date.now() - 86_400_000);
    const due = await createWatch(f.ceiling, { orgId: f.orgId, kind: 'ticket_waiting', params: {}, cadenceMinutes: 60 }, past);
    const notDue = await createWatch(f.ceiling, { orgId: null, kind: 'ticket_cluster', params: {}, cadenceMinutes: 1440 });
    const now = new Date();
    const claimed = await claimDueWatches(now, 100);
    const ids = claimed.map((w) => w.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(notDue.id);
    const [row] = await asSystem(() => db.select().from(wispWatches).where(eq(wispWatches.id, due.id)));
    expect(row!.lastRanAt!.getTime()).toBe(now.getTime());
    expect(row!.nextDueAt.getTime()).toBe(now.getTime() + 60 * 60_000);
    // A second claim at the same instant finds nothing due.
    expect((await claimDueWatches(now, 100)).map((w) => w.id)).not.toContain(due.id);
  });

  it('a paused grant stops its watches with stopped_reason paused and notifies the partner admin once', async () => {
    const f = await seed();
    const w = await createWatch(f.ceiling, { orgId: f.orgId, kind: 'backup_health', params: {}, cadenceMinutes: 60 });
    await asSystem(() => db.update(wispGrants).set({ status: 'paused', pausedReason: 'grantor_access_lost', pausedAt: new Date() })
      .where(eq(wispGrants.id, f.grant.grantId)));
    const first = await stopWatchesForInactiveGrants(new Date());
    expect(first.stopped).toBeGreaterThanOrEqual(1);
    const [row] = await asSystem(() => db.select().from(wispWatches).where(eq(wispWatches.id, w.id)));
    expect(row!.status).toBe('stopped');
    expect(row!.stoppedReason).toBe('paused');
    expect(await orphanNotices(f.adminId, f.grant.grantId)).toHaveLength(1);
    // The grantor is not a partner admin here, so gets nothing.
    expect(await orphanNotices(f.grantorId, f.grant.grantId)).toHaveLength(0);
    // Next tick: nothing left to stop, no second notice.
    await stopWatchesForInactiveGrants(new Date());
    expect(await orphanNotices(f.adminId, f.grant.grantId)).toHaveLength(1);
  });

  it('a user-paused grant stops its watches but notifies nobody', async () => {
    const f = await seed();
    const w = await createWatch(f.ceiling, { orgId: f.orgId, kind: 'ticket_waiting', params: {}, cadenceMinutes: 60 });
    await asSystem(() => db.update(wispGrants).set({ status: 'paused', pausedReason: 'user_paused', pausedAt: new Date() })
      .where(eq(wispGrants.id, f.grant.grantId)));
    await stopWatchesForInactiveGrants(new Date());
    const [row] = await asSystem(() => db.select().from(wispWatches).where(eq(wispWatches.id, w.id)));
    expect(row!.stoppedReason).toBe('paused');
    expect(await orphanNotices(f.adminId, f.grant.grantId)).toHaveLength(0);
  });

  it('the per-grant cap holds under concurrent creates', async () => {
    const f = await seed();
    const results = await Promise.allSettled(Array.from({ length: WATCH_MAX_PER_GRANT + 5 }, () =>
      createWatch(f.ceiling, { orgId: f.orgId, kind: 'ticket_waiting', params: {}, cadenceMinutes: 60 })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const capped = results.filter((r) => r.status === 'rejected' && r.reason instanceof WatchLimitReachedError).length;
    expect(ok).toBe(WATCH_MAX_PER_GRANT);
    expect(capped).toBe(5);
  });
});

// #11424: the in-code watch evaluation (services/wisp/watchHits.ts) and the
// hit-set compare-and-set, against real tables.
describe('wisp watch hit-sets (real Postgres, #11424)', () => {
  const EMPTY_HASH = createHash('sha256').update('').digest('hex');

  async function seedDevice(orgId: string) {
    const site = await createSite({ orgId });
    return createDevice({ orgId, siteId: site!.id });
  }

  it('alert_pattern: an unchanged open alert keeps its hash; acknowledging or resolving it changes it; exact params narrow', async () => {
    const f = await seed();
    const device = await seedDevice(f.orgId);
    const evaluate = (params: Record<string, unknown> = {}) => evaluateWatchHits({ kind: 'alert_pattern', params }, f.orgId, new Date());

    const empty = await evaluate();
    expect(empty).toEqual({ subject: 'alert', count: 0, hash: EMPTY_HASH, ids: [] });

    const [alert] = await getTestDb().insert(alerts).values({
      orgId: f.orgId, deviceId: device.id, severity: 'medium', title: 'Synthetic disk alert', status: 'active',
    }).returning({ id: alerts.id });
    // A resolved alert in the same org is never a hit.
    await getTestDb().insert(alerts).values({
      orgId: f.orgId, deviceId: device.id, severity: 'critical', title: 'Synthetic old alert', status: 'resolved', resolvedAt: new Date(),
    });

    const one = await evaluate();
    expect(one).toMatchObject({ count: 1, ids: [alert!.id] });
    expect(one!.hash).not.toBe(EMPTY_HASH);
    // The same open alert on the next cadence: same hash (no run).
    expect((await evaluate())!.hash).toBe(one!.hash);
    // Free text is not a filter; a severity floor and device ids are.
    expect((await evaluate({ pattern: 'something unrelated' }))!.hash).toBe(one!.hash);
    expect((await evaluate({ severity: 'high' }))!.count).toBe(0);
    expect((await evaluate({ severity: 'low' }))!.count).toBe(1);
    expect((await evaluate({ deviceId: randomUUID() }))!.count).toBe(0);
    expect((await evaluate({ deviceId: device.id }))!.count).toBe(1);

    await getTestDb().update(alerts).set({ status: 'acknowledged', acknowledgedAt: new Date() }).where(eq(alerts.id, alert!.id));
    const acked = await evaluate();
    expect(acked!.count).toBe(1);
    expect(acked!.hash).not.toBe(one!.hash);

    await getTestDb().update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.id, alert!.id));
    expect(await evaluate()).toEqual({ subject: 'alert', count: 0, hash: EMPTY_HASH, ids: [] });
  });

  it('security_findings: an open vulnerability is a hit, a patched one is not', async () => {
    const f = await seed();
    const device = await seedDevice(f.orgId);
    const evaluate = () => evaluateWatchHits({ kind: 'security_findings', params: {} }, f.orgId, new Date());
    expect(await evaluate()).toEqual({ subject: 'finding', count: 0, hash: EMPTY_HASH, ids: [] });

    const [vuln] = await getTestDb().insert(vulnerabilities).values({
      cveId: `CVE-2099-${Math.floor(Math.random() * 90_000) + 10_000}`, description: 'Synthetic vulnerability', rawPayload: {},
    }).returning({ id: vulnerabilities.id });
    const [finding] = await getTestDb().insert(deviceVulnerabilities).values({
      orgId: f.orgId, deviceId: device.id, vulnerabilityId: vuln!.id, status: 'open', detectedAt: new Date(),
    }).returning({ id: deviceVulnerabilities.id });
    expect(await evaluate()).toMatchObject({ count: 1, ids: [finding!.id] });

    await getTestDb().update(deviceVulnerabilities).set({ status: 'patched', resolvedAt: new Date() }).where(eq(deviceVulnerabilities.id, finding!.id));
    expect((await evaluate())!.hash).toBe(EMPTY_HASH);
  });

  it('patch_compliance: a device whose fresh latest snapshot is below the threshold is a hit; stale snapshots and data gaps are not', async () => {
    const f = await seed();
    const below = await seedDevice(f.orgId);
    const gap = await seedDevice(f.orgId);
    const recovered = await seedDevice(f.orgId);
    const now = new Date();
    const snapshot = (deviceId: string, score: number, capturedAt: Date, factorDetails: Record<string, unknown> = {}) => ({
      orgId: f.orgId, deviceId, capturedAt, overallScore: score, riskLevel: 'medium' as const, patchComplianceScore: score,
      encryptionScore: 100, avHealthScore: 100, firewallScore: 100, openPortsScore: 100, passwordPolicyScore: 100,
      osCurrencyScore: 100, adminExposureScore: 100, factorDetails,
    });
    await getTestDb().insert(securityPostureSnapshots).values([
      snapshot(below.id, 60, new Date(now.getTime() - 60 * 60_000)),
      snapshot(gap.id, 40, new Date(now.getTime() - 60 * 60_000), { patch_compliance: { dataGap: 'no patch telemetry' } }),
      // Was below two hours ago, compliant in its latest snapshot.
      snapshot(recovered.id, 50, new Date(now.getTime() - 120 * 60_000)),
      snapshot(recovered.id, 95, new Date(now.getTime() - 30 * 60_000)),
    ]);
    const hits = await evaluateWatchHits({ kind: 'patch_compliance', params: { threshold: 80 } }, f.orgId, now);
    expect(hits).toMatchObject({ subject: 'device', count: 1, ids: [below.id] });
    // Fractional thresholds against the integer column (a fraction, and a non-integer percent).
    expect(await evaluateWatchHits({ kind: 'patch_compliance', params: { minCompliance: 0.605 } }, f.orgId, now)).toMatchObject({ count: 1, ids: [below.id] });
    expect(await evaluateWatchHits({ kind: 'patch_compliance', params: { threshold: 60.5 } }, f.orgId, now)).toMatchObject({ count: 1, ids: [below.id] });
    expect(await evaluateWatchHits({ kind: 'patch_compliance', params: { threshold: 59.5 } }, f.orgId, now)).toMatchObject({ count: 0 });
    // A day later every snapshot is stale: nothing is current evidence.
    const later = await evaluateWatchHits({ kind: 'patch_compliance', params: { threshold: 80 } }, f.orgId, new Date(now.getTime() + 26 * 3_600_000));
    expect(later).toMatchObject({ count: 0, hash: EMPTY_HASH });
  });

  it('recordWatchHits compare-and-sets on the claimed hash, and the next claim returns what was recorded', async () => {
    const f = await seed();
    const past = new Date(Date.now() - 86_400_000);
    const w = await createWatch(f.ceiling, { orgId: f.orgId, kind: 'alert_pattern', params: {}, cadenceMinutes: 60 }, past);
    const first = (await claimDueWatches(new Date(), 100)).find((c) => c.id === w.id);
    expect(first).toMatchObject({ hitHash: null, hitCount: null });

    expect(await recordWatchHits(w.id, null, { hash: 'h1', count: 2 })).toBe(true);
    // A writer still holding the old (NULL) hash loses.
    expect(await recordWatchHits(w.id, null, { hash: 'h2', count: 5 })).toBe(false);
    expect(await recordWatchHits(w.id, 'h1', { hash: EMPTY_HASH, count: 0 })).toBe(true);

    const second = (await claimDueWatches(new Date(Date.now() + 2 * 3_600_000), 100)).find((c) => c.id === w.id);
    expect(second).toMatchObject({ hitHash: EMPTY_HASH, hitCount: 0 });
  });
});
