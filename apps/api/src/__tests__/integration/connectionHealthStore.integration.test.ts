/**
 * Connection health incident store (spec 2026-10-15 §2.2). The store runs in
 * the caller's system context (the reconciler wraps it), so every call here
 * goes through asSystem.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents } from '../../db/schema';
import { createPartner } from './db-utils';
import {
  applyActions,
  deleteExpiredResolved,
  loadTracked,
  permissionFromText,
  permissionToText,
} from '../../services/connectionHealth/store';
import { REOPEN_WINDOW_MS, type HealthObservation } from '../../services/connectionHealth/types';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const EARLIER = new Date('2026-10-15T11:00:00.000Z');
const USER_A = '00000000-0000-4000-8000-00000000000a';

const minutesBefore = (d: Date, m: number) => new Date(d.getTime() - m * 60_000);
const daysBefore = (d: Date, n: number) => new Date(d.getTime() - n * 86_400_000);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

let P: string;

function obs(over: Partial<HealthObservation> = {}): HealthObservation {
  return {
    sourceKind: 'oauth_grant',
    sourceId: 'grant-1',
    partnerId: P,
    orgId: null,
    ownerUserId: null,
    state: 'broken',
    severity: 'transient',
    condition: 'reauth_required',
    detail: null,
    displayName: 'Test connected app',
    fixHref: '/settings/connected-apps',
    ownerFixHref: null,
    viewPermission: { resource: 'connected_apps', action: 'read' },
    repairPermission: { resource: 'connected_apps', action: 'manage' },
    observedAt: NOW,
    ...over,
  };
}

async function insertRow(over: Partial<typeof connectionHealthIncidents.$inferInsert> & { sourceId: string }) {
  await db.insert(connectionHealthIncidents).values({
    partnerId: P,
    sourceKind: 'oauth_grant',
    condition: 'reauth_required',
    severity: 'permanent',
    displayName: 'Test connected app',
    fixHref: '/settings/connected-apps',
    viewPermission: 'connected_apps:read',
    repairPermission: 'connected_apps:manage',
    firstFailedAt: EARLIER,
    lastObservedAt: EARLIER,
    ...over,
  });
}

const allRows = () => asSystem(() => db.select().from(connectionHealthIncidents));

describe('connection health store', () => {
  // setup.ts truncates partners CASCADE before each test (taking incidents with it).
  beforeEach(async () => {
    P = (await createPartner()).id;
    await asSystem(() => db.delete(connectionHealthIncidents));
  });

  it('permission text round-trips and rejects malformed input', () => {
    expect(permissionToText({ resource: 'connected_apps', action: 'manage' })).toBe('connected_apps:manage');
    expect(permissionFromText('connected_apps:manage')).toEqual({ resource: 'connected_apps', action: 'manage' });
    expect(() => permissionFromText('nocolon')).toThrow();
    expect(() => permissionFromText(':x')).toThrow();
  });

  it('insertOpen with notify sets opened_at and pending_notice=opened', async () => {
    const res = await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], NOW));
    expect(res).toEqual({ opened: 1, resolved: 0, pending: 0 });
    const [row] = await allRows();
    expect(row).toMatchObject({ openedAt: NOW, pendingNotice: 'opened', firstFailedAt: NOW, repairPermission: 'connected_apps:manage' });
  });

  it('insertOpen in seed mode leaves pending_notice null', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], NOW));
    expect((await allRows())[0]!.pendingNotice).toBeNull();
  });

  it('insertPending leaves opened_at null and counts as pending', async () => {
    const res = await asSystem(() => applyActions([{ type: 'insertPending', obs: obs() }], NOW));
    expect(res).toEqual({ opened: 0, resolved: 0, pending: 1 });
    expect((await allRows())[0]).toMatchObject({ openedAt: null, pendingNotice: null, firstFailedAt: NOW });
  });

  it('promotePending keeps first_failed_at, opens now, and zeroes the streak', async () => {
    await asSystem(() => applyActions([{ type: 'insertPending', obs: obs() }], EARLIER));
    const [p] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => db.update(connectionHealthIncidents).set({ healthyStreak: 1 }));
    await asSystem(() => applyActions([{ type: 'promotePending', incidentId: p!.id, obs: obs({ severity: 'permanent' }), notify: true }], NOW));
    const [row] = await allRows();
    expect(row).toMatchObject({ firstFailedAt: EARLIER, openedAt: NOW, pendingNotice: 'opened', healthyStreak: 0, severity: 'permanent' });
  });

  it('update resets healthy_streak and escalation sets pending_notice=escalated', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], EARLIER));
    const [t] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions([{ type: 'healthyTick', incidentId: t!.id, healthyStreak: 1 }], NOW));
    expect((await allRows())[0]!.healthyStreak).toBe(1);
    await asSystem(() => applyActions([{ type: 'update', incidentId: t!.id, obs: obs({ severity: 'permanent' }), escalated: true }], NOW));
    const [row] = await allRows();
    expect(row).toMatchObject({ healthyStreak: 0, severity: 'permanent', pendingNotice: 'escalated' });
  });

  it('update without escalation leaves pending_notice untouched', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], EARLIER));
    const [t] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions([{ type: 'update', incidentId: t!.id, obs: obs({ detail: 'new' }), escalated: false }], NOW));
    expect((await allRows())[0]).toMatchObject({ pendingNotice: 'opened', detail: 'new', lastObservedAt: NOW });
  });

  it('resolve sets resolution and pending_notice=resolved only if anyone was notified', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ sourceId: 'a' }), notify: false }, { type: 'insertOpen', obs: obs({ sourceId: 'b' }), notify: false }], EARLIER));
    await asSystem(() => db.update(connectionHealthIncidents).set({ notifiedUserIds: [USER_A] }).where(eq(connectionHealthIncidents.sourceId, 'b')));
    const tracked = await asSystem(() => loadTracked('oauth_grant', NOW));
    const res = await asSystem(() => applyActions(tracked.map((t) => ({ type: 'resolve' as const, incidentId: t.id, resolution: 'recovered' as const })), NOW));
    expect(res.resolved).toBe(2);
    const rows = await allRows();
    expect(Object.fromEntries(rows.map((r) => [r.sourceId, [r.resolution, r.pendingNotice]])))
      .toEqual({ a: ['recovered', null], b: ['recovered', 'resolved'] });
    expect(rows.every((r) => r.resolvedAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it('reopen clears resolution, bumps flap_count, writes observed columns, zeroes streak, opens now', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], EARLIER));
    const [t] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: t!.id, resolution: 'recovered' }], EARLIER));
    await asSystem(() => db.update(connectionHealthIncidents).set({ healthyStreak: 2 }));
    await asSystem(() => applyActions([{ type: 'reopen', incidentId: t!.id, obs: obs({ severity: 'permanent', detail: 'again' }) }], NOW));
    const [row] = await allRows();
    expect(row).toMatchObject({
      resolvedAt: null, resolution: null, flapCount: 1, openedAt: NOW, pendingNotice: 'opened',
      healthyStreak: 0, severity: 'permanent', detail: 'again', lastObservedAt: NOW,
    });
  });

  it('deletePending removes only never-opened rows', async () => {
    await asSystem(() => applyActions([
      { type: 'insertPending', obs: obs({ sourceId: 'p' }) },
      { type: 'insertOpen', obs: obs({ sourceId: 'o' }), notify: false },
    ], EARLIER));
    const tracked = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions(tracked.map((t) => ({ type: 'deletePending' as const, incidentId: t.id })), NOW));
    expect((await allRows()).map((r) => r.sourceId)).toEqual(['o']);
  });

  it('loadTracked returns open, pending and recently-resolved-recovered rows only', async () => {
    await asSystem(async () => {
      await insertRow({ sourceId: 'open', openedAt: EARLIER });
      await insertRow({ sourceId: 'pending', openedAt: null });
      await insertRow({ sourceId: 'recent', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 30), resolution: 'recovered' });
      await insertRow({ sourceId: 'old', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 120), resolution: 'recovered' });
      await insertRow({ sourceId: 'retired', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 30), resolution: 'retired' });
    });
    const ids = (await asSystem(() => loadTracked('oauth_grant', NOW))).map((t) => t.sourceId).sort();
    expect(ids).toEqual(['open', 'pending', 'recent']);
  });

  it('loadTracked includes a recovered row resolved exactly REOPEN_WINDOW_MS ago (inclusive, matches planner)', async () => {
    await asSystem(() => insertRow({
      sourceId: 'edge', openedAt: EARLIER,
      resolvedAt: new Date(NOW.getTime() - REOPEN_WINDOW_MS), resolution: 'recovered',
    }));
    const ids = (await asSystem(() => loadTracked('oauth_grant', NOW))).map((t) => t.sourceId);
    expect(ids).toEqual(['edge']);
  });

  it('loadTracked prefers the open row over an older resolved row for the same source', async () => {
    await asSystem(async () => {
      await insertRow({ sourceId: 's', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 30), resolution: 'recovered' });
      await insertRow({ sourceId: 's', openedAt: EARLIER });
    });
    const tracked = await asSystem(() => loadTracked('oauth_grant', NOW));
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.resolvedAt).toBeNull();
  });

  it('deleteExpiredResolved removes only resolved rows older than 90 days, bounded by limit', async () => {
    await asSystem(async () => {
      for (const id of ['x1', 'x2', 'x3']) await insertRow({ sourceId: id, openedAt: daysBefore(NOW, 100), resolvedAt: daysBefore(NOW, 91), resolution: 'recovered' });
      await insertRow({ sourceId: 'keep', openedAt: daysBefore(NOW, 100), resolvedAt: daysBefore(NOW, 89), resolution: 'recovered' });
      await insertRow({ sourceId: 'openold', openedAt: daysBefore(NOW, 200) });
    });
    expect(await asSystem(() => deleteExpiredResolved(NOW, 2))).toBe(2);
    expect(await asSystem(() => deleteExpiredResolved(NOW, 2))).toBe(1);
    const left = (await allRows()).map((r) => r.sourceId).sort();
    expect(left).toEqual(['keep', 'openold']);
  });
});
