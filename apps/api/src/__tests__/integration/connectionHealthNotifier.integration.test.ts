/**
 * Connection health notifier against real Postgres + RLS (spec 2026-10-15
 * §2.1 notice outbox, §4 in-app notices). The notifier drains
 * `pending_notice` into user_notifications: one coherent notice per
 * (episode, recipient), a crash before the outbox clears retries, a deleted
 * notice never comes back, and an overwritten single-slot outbox value still
 * leaves no stale unread notice behind.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents, userNotifications } from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import * as userNotificationsModule from '../../services/userNotifications';
import { createNotification, markNotificationsReadByDedupeKeyPrefix } from '../../services/userNotifications';
import { applyActions } from '../../services/connectionHealth/store';
import { deliverPendingNotices, noticeDedupeKeys } from '../../services/connectionHealth/notifier';
import { setConnectionHealthMetricsRecorder } from '../../services/connectionHealth/metrics';
import type { HealthObservation } from '../../services/connectionHealth/types';

const OPENED_AT = new Date('2026-10-15T11:00:00.000Z');
const RESOLVED_AT = new Date('2026-10-15T11:30:00.000Z');
const REOPENED_AT = new Date('2026-10-15T11:45:00.000Z');
const NOW = new Date('2026-10-15T12:00:00.000Z');
const MANAGE = { resource: 'connected_apps', action: 'manage' };

const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

let P: string;
let orgA: string;
let u1: string; // partner admin holding connected_apps:manage, orgAccess all
let o1: string; // connection owner, no partner role
let incidentId: string;
let emailSeq = 0;

const email = () => `notifier-${Date.now()}-${(emailSeq += 1)}@example.com`;

function obs(over: Partial<HealthObservation> = {}): HealthObservation {
  return {
    sourceKind: 'oauth_grant',
    sourceId: 'grant-1',
    partnerId: P,
    orgId: null,
    ownerUserId: o1,
    state: 'broken',
    severity: 'permanent',
    condition: 'reauth_required',
    detail: null,
    displayName: 'Test connected app',
    fixHref: '/settings/connected-apps',
    ownerFixHref: '/account/connected-apps',
    viewPermission: { resource: 'connected_apps', action: 'read' },
    repairPermission: MANAGE,
    observedAt: OPENED_AT,
    ...over,
  };
}

async function openIncident(over: Partial<HealthObservation> = {}, at = OPENED_AT): Promise<string> {
  await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ observedAt: at, ...over }), notify: true }], at));
  const sourceId = over.sourceId ?? 'grant-1';
  const [row] = await asSystem(() =>
    db.select().from(connectionHealthIncidents).where(eq(connectionHealthIncidents.sourceId, sourceId)),
  );
  return row!.id;
}

const incidents = () => asSystem(() => db.select().from(connectionHealthIncidents));
const incident = async (id = incidentId) =>
  (await asSystem(() => db.select().from(connectionHealthIncidents).where(eq(connectionHealthIncidents.id, id))))[0]!;
const notes = () => asSystem(() => db.select().from(userNotifications));
const notesFor = (userId: string) =>
  asSystem(() => db.select().from(userNotifications).where(eq(userNotifications.userId, userId)));

describe('deliverPendingNotices', () => {
  beforeEach(async () => {
    P = (await createPartner()).id;
    orgA = (await createOrganization({ partnerId: P })).id;
    const role = await createRole({ scope: 'partner', partnerId: P, name: 'repairers' });
    await grantRolePermissions(role.id, [MANAGE]);
    u1 = (await createUser({ partnerId: P, email: email() })).id;
    await assignUserToPartner(u1, P, role.id, 'all');
    o1 = (await createUser({ partnerId: P, orgId: orgA, email: email() })).id;
    await asSystem(() => db.delete(connectionHealthIncidents));
    incidentId = await openIncident();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opened → one notice per recipient, owner gets owner_fix_href, ids recorded, outbox cleared', async () => {
    const result = await deliverPendingNotices(NOW);
    expect(result).toEqual({ delivered: 1, failed: 0, zeroRecipients: 0 });
    const all = await notes();
    expect(all.map((n) => [n.userId, n.link, n.type, n.priority]).sort()).toEqual([
      [o1, '/account/connected-apps', 'integration', 'high'],
      [u1, '/settings/connected-apps', 'integration', 'high'],
    ].sort());
    expect(all.every((n) => n.dedupeKey === noticeDedupeKeys(incidentId, OPENED_AT).opened)).toBe(true);
    expect(all.every((n) => n.orgId === null && n.read === false)).toBe(true);
    const inc = await incident();
    expect(inc.pendingNotice).toBeNull();
    expect([...inc.notifiedUserIds].sort()).toEqual([o1, u1].sort());
  });

  it('dedupe keys follow the shared constant format', () => {
    const k = noticeDedupeKeys('abc', OPENED_AT);
    expect(k).toEqual({
      opened: `connection-health:abc:${OPENED_AT.getTime()}`,
      permanent: `connection-health:abc:${OPENED_AT.getTime()}:permanent`,
    });
  });

  it('transient org incident → normal priority, notice carries the org', async () => {
    await asSystem(() => db.delete(connectionHealthIncidents));
    incidentId = await openIncident({ severity: 'transient', orgId: orgA, ownerUserId: null });
    await deliverPendingNotices(NOW);
    const all = await notes();
    expect(all.map((n) => [n.userId, n.priority, n.orgId])).toEqual([[u1, 'normal', orgA]]);
  });

  it('escalated → a second notice with the :permanent key', async () => {
    await deliverPendingNotices(NOW);
    await asSystem(() => db.update(connectionHealthIncidents).set({ pendingNotice: 'escalated' }));
    await deliverPendingNotices(NOW);
    const keys = (await notesFor(u1)).map((n) => n.dedupeKey).sort();
    const { opened, permanent } = noticeDedupeKeys(incidentId, OPENED_AT);
    expect(keys).toEqual([opened, permanent].sort());
    const inc = await incident();
    expect(inc.pendingNotice).toBeNull();
    expect([...inc.notifiedUserIds].sort()).toEqual([o1, u1].sort());
  });

  it("resolved → marks exactly the recorded users' notices read, creates nothing", async () => {
    await deliverPendingNotices(NOW);
    await asSystem(() =>
      createNotification({ userId: u1, orgId: null, type: 'integration', title: 'other', dedupeKey: 'unrelated' }),
    );
    await asSystem(() =>
      db.update(connectionHealthIncidents).set({ pendingNotice: 'resolved', resolvedAt: NOW, resolution: 'recovered' }),
    );
    await deliverPendingNotices(NOW);
    const all = await notes();
    expect(all).toHaveLength(3);
    expect(all.filter((n) => n.read).map((n) => n.userId).sort()).toEqual([o1, u1].sort());
    expect(all.find((n) => n.dedupeKey === 'unrelated')!.read).toBe(false);
    expect(await incident()).toMatchObject({ pendingNotice: null, notifiedUserIds: [] });
  });

  it('does not recreate a deleted notice on a later run', async () => {
    await deliverPendingNotices(NOW);
    await asSystem(() => db.delete(userNotifications).where(eq(userNotifications.userId, u1)));
    expect(await deliverPendingNotices(NOW)).toEqual({ delivered: 0, failed: 0, zeroRecipients: 0 }); // outbox already empty
    expect(await notesFor(u1)).toHaveLength(0);
    expect(await notesFor(o1)).toHaveLength(1);
  });

  it('a recipient failure leaves pending_notice set so the next run retries', async () => {
    // First recipient succeeds, second fails: the first insert must roll back too.
    const real = userNotificationsModule.createNotification;
    const spy = vi.spyOn(userNotificationsModule, 'createNotification')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('db blip'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await deliverPendingNotices(NOW);
    expect(result).toEqual({ delivered: 0, failed: 1, zeroRecipients: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    const inc = await incident();
    expect(inc.pendingNotice).toBe('opened');
    expect(inc.notifiedUserIds).toEqual([]);
    expect(await notes()).toHaveLength(0); // the partial delivery rolled back
    spy.mockRestore();
    expect(await deliverPendingNotices(NOW)).toEqual({ delivered: 1, failed: 0, zeroRecipients: 0 });
    expect(await notes()).toHaveLength(2);
    expect((await incident()).pendingNotice).toBeNull();
  });

  it('one failing incident does not block the others', async () => {
    const second = await openIncident({ sourceId: 'grant-2', displayName: 'Second app' });
    vi.spyOn(userNotificationsModule, 'createNotification').mockRejectedValueOnce(new Error('db blip'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await deliverPendingNotices(NOW);
    expect(result).toEqual({ delivered: 1, failed: 1, zeroRecipients: 0 });
    const pending = (await incidents()).map((r) => r.pendingNotice).sort();
    expect(pending).toEqual(['opened', null].sort());
    vi.restoreAllMocks();
    expect(await deliverPendingNotices(NOW)).toEqual({ delivered: 1, failed: 0, zeroRecipients: 0 });
    expect((await incidents()).every((r) => r.pendingNotice === null)).toBe(true);
    // Two incidents × (u1, o1), one notice each.
    expect(await notes()).toHaveLength(4);
    expect((await incident(second)).notifiedUserIds).toHaveLength(2);
  });

  it('zero recipients logs a warning and clears the outbox', async () => {
    await asSystem(() =>
      db.update(connectionHealthIncidents).set({ ownerUserId: null, repairPermission: 'nobody:has' }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const counted: string[] = [];
    setConnectionHealthMetricsRecorder({ onZeroRecipientIncident: (k) => counted.push(k) });
    try {
      expect(await deliverPendingNotices(NOW)).toEqual({ delivered: 1, failed: 0, zeroRecipients: 1 });
    } finally {
      setConnectionHealthMetricsRecorder(null);
    }
    expect(counted).toEqual(['oauth_grant']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('connection_health_zero_recipients'))).toBe(true);
    expect((await incident()).pendingNotice).toBeNull();
    expect(await notes()).toHaveLength(0);
  });

  it('respects the limit', async () => {
    await openIncident({ sourceId: 'grant-2' });
    expect(await deliverPendingNotices(NOW, { limit: 1 })).toEqual({ delivered: 1, failed: 0, zeroRecipients: 0 });
    expect((await incidents()).filter((r) => r.pendingNotice !== null)).toHaveLength(1);
  });

  describe('single-slot outbox overwritten before delivery', () => {
    it('resolved then reopened before delivery: the resolve is cancelled and the episode notices stay unread', async () => {
      await deliverPendingNotices(NOW); // episode 1 delivered to u1 + o1
      await asSystem(() => applyActions([{ type: 'resolve', incidentId, resolution: 'recovered' }], RESOLVED_AT));
      expect((await incident()).pendingNotice).toBe('resolved');
      // A flap inside the reopen window is the same episode (W2): nothing new is
      // queued and the undelivered 'resolved' is cancelled.
      await asSystem(() =>
        applyActions([{ type: 'reopen', incidentId, obs: obs({ observedAt: REOPENED_AT }), escalated: false }], REOPENED_AT),
      );
      const reopened = await incident();
      expect(reopened).toMatchObject({ pendingNotice: null, openedAt: OPENED_AT, flapCount: 1 });
      expect([...reopened.notifiedUserIds].sort()).toEqual([o1, u1].sort());

      expect(await deliverPendingNotices(NOW)).toEqual({ delivered: 0, failed: 0, zeroRecipients: 0 });
      const key = noticeDedupeKeys(incidentId, OPENED_AT).opened;
      const all = await notes();
      expect(all.map((n) => [n.userId, n.dedupeKey, n.read]).sort()).toEqual([[o1, key, false], [u1, key, false]].sort());
    });

    it('a flap after the resolve was delivered sends no new notice (spec goal 3)', async () => {
      await deliverPendingNotices(NOW);
      await asSystem(() => applyActions([{ type: 'resolve', incidentId, resolution: 'recovered' }], RESOLVED_AT));
      await deliverPendingNotices(NOW); // marks the episode read, clears recipients
      await asSystem(() =>
        applyActions([{ type: 'reopen', incidentId, obs: obs({ observedAt: REOPENED_AT }), escalated: false }], REOPENED_AT),
      );
      expect(await deliverPendingNotices(NOW)).toEqual({ delivered: 0, failed: 0, zeroRecipients: 0 });
      const all = await notes();
      expect(all).toHaveLength(2);
      expect(all.every((n) => n.read)).toBe(true);
    });

    it('escalated overwriting an undelivered opened → exactly one notice, the permanent key', async () => {
      await asSystem(() => db.delete(connectionHealthIncidents));
      incidentId = await openIncident({ severity: 'transient' });
      await asSystem(() =>
        applyActions(
          [{ type: 'update', incidentId, obs: obs({ severity: 'permanent', observedAt: NOW }), escalated: true }],
          NOW,
        ),
      );
      expect((await incident()).pendingNotice).toBe('escalated');
      await deliverPendingNotices(NOW);
      const { permanent } = noticeDedupeKeys(incidentId, OPENED_AT);
      expect((await notesFor(u1)).map((n) => [n.dedupeKey, n.priority])).toEqual([[permanent, 'high']]);
      expect((await notesFor(o1)).map((n) => n.dedupeKey)).toEqual([permanent]);
      expect([...(await incident()).notifiedUserIds].sort()).toEqual([o1, u1].sort());
    });

    it('resolved → reopened → escalated before delivery: the episode keeps its notice and gains the permanent one', async () => {
      await deliverPendingNotices(NOW);
      await asSystem(() => applyActions([{ type: 'resolve', incidentId, resolution: 'recovered' }], RESOLVED_AT));
      await asSystem(() =>
        applyActions(
          [{ type: 'reopen', incidentId, obs: obs({ severity: 'transient', observedAt: REOPENED_AT }), escalated: false }],
          REOPENED_AT,
        ),
      );
      await asSystem(() =>
        applyActions([{ type: 'update', incidentId, obs: obs({ observedAt: NOW }), escalated: true }], NOW),
      );
      await deliverPendingNotices(NOW);
      const { opened, permanent } = noticeDedupeKeys(incidentId, OPENED_AT);
      const unread = (await notes()).filter((n) => !n.read);
      expect(unread.map((n) => [n.userId, n.dedupeKey]).sort()).toEqual(
        [[o1, opened], [o1, permanent], [u1, opened], [u1, permanent]].sort(),
      );
    });

    it('an escalating reopen queues the permanent notice for the same episode', async () => {
      await deliverPendingNotices(NOW);
      await asSystem(() => applyActions([{ type: 'resolve', incidentId, resolution: 'recovered' }], RESOLVED_AT));
      await deliverPendingNotices(NOW);
      await asSystem(() =>
        applyActions([{ type: 'reopen', incidentId, obs: obs({ severity: 'permanent', observedAt: REOPENED_AT }), escalated: true }], REOPENED_AT),
      );
      expect((await incident()).pendingNotice).toBe('escalated');
      await deliverPendingNotices(NOW);
      const { permanent } = noticeDedupeKeys(incidentId, OPENED_AT);
      expect((await notes()).filter((n) => !n.read).map((n) => [n.userId, n.dedupeKey]).sort())
        .toEqual([[o1, permanent], [u1, permanent]].sort());
    });

    it('resolved → reopened → resolved before delivery: every episode notice ends up read', async () => {
      await deliverPendingNotices(NOW);
      await asSystem(() => applyActions([{ type: 'resolve', incidentId, resolution: 'recovered' }], RESOLVED_AT));
      await asSystem(() =>
        applyActions([{ type: 'reopen', incidentId, obs: obs({ observedAt: REOPENED_AT }), escalated: false }], REOPENED_AT),
      );
      await asSystem(() => applyActions([{ type: 'resolve', incidentId, resolution: 'recovered' }], NOW));
      expect((await incident()).pendingNotice).toBe('resolved');
      await deliverPendingNotices(NOW);
      const all = await notes();
      expect(all).toHaveLength(2);
      expect(all.every((n) => n.read)).toBe(true);
      expect(await incident()).toMatchObject({ pendingNotice: null, notifiedUserIds: [] });
    });
  });
});

describe('markNotificationsReadByDedupeKeyPrefix', () => {
  let a: string;
  let b: string;

  beforeEach(async () => {
    const partner = await createPartner();
    a = (await createUser({ partnerId: partner.id, email: email() })).id;
    b = (await createUser({ partnerId: partner.id, email: email() })).id;
    const keys: Array<[string, string]> = [
      [a, 'connection-health:inc_1:100'],
      [a, 'connection-health:inc_1:200:permanent'],
      [a, 'connection-health:inc_1:300'],
      [a, 'connection-health:inc_2:100'],
      [a, 'connection-health:incX1:100'], // matches only if `_` is left unescaped
      [b, 'connection-health:inc_1:100'],
    ];
    for (const [userId, dedupeKey] of keys) {
      await asSystem(() => createNotification({ userId, orgId: null, type: 'integration', title: 't', dedupeKey }));
    }
  });

  const readKeys = async (userId: string) =>
    (await asSystem(() =>
      db.select().from(userNotifications).where(and(eq(userNotifications.userId, userId), eq(userNotifications.read, true))),
    )).map((n) => n.dedupeKey).sort();

  it("marks only the listed users' prefixed keys, minus the exceptions", async () => {
    const n = await asSystem(() =>
      markNotificationsReadByDedupeKeyPrefix([a], 'connection-health:inc_1:', ['connection-health:inc_1:300']),
    );
    expect(n).toBe(2);
    expect(await readKeys(a)).toEqual(['connection-health:inc_1:100', 'connection-health:inc_1:200:permanent']);
    expect(await readKeys(b)).toEqual([]);
  });

  it('with no exceptions marks every prefixed key, and is a no-op for no users', async () => {
    expect(await asSystem(() => markNotificationsReadByDedupeKeyPrefix([], 'connection-health:inc_1:', []))).toBe(0);
    expect(await asSystem(() => markNotificationsReadByDedupeKeyPrefix([a, b], 'connection-health:inc_1:', []))).toBe(4);
    expect(await readKeys(a)).toEqual([
      'connection-health:inc_1:100',
      'connection-health:inc_1:200:permanent',
      'connection-health:inc_1:300',
    ]);
    expect(await readKeys(b)).toEqual(['connection-health:inc_1:100']);
    // Already-read rows are not counted again.
    expect(await asSystem(() => markNotificationsReadByDedupeKeyPrefix([a, b], 'connection-health:inc_1:', []))).toBe(0);
  });
});
