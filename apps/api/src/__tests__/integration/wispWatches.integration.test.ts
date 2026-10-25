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
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { userNotifications, wispGrantRevisions, wispGrants, wispWatches } from '../../db/schema';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import {
  claimDueWatches,
  createWatch,
  stopWatchesForInactiveGrants,
  WATCH_MAX_PER_GRANT,
  WatchLimitReachedError,
} from '../../services/wisp/watches';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser } from './db-utils';

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
