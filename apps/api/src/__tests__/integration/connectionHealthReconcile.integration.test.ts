/**
 * Connection health reconciler end to end (spec 2026-10-15 §1.2, §1.3, §8):
 * real Postgres + forced RLS, the real OAuth grant source, the real notifier
 * and the shared test Redis. Each kind runs in one system transaction, so a
 * failure part-way through applying leaves that kind's incidents untouched.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents, oauthClients, oauthGrants, userNotifications } from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestRedis } from './setup';
import { runReconcile } from '../../services/connectionHealth/reconcile';
import { oauthGrantSource } from '../../services/connectionHealth/sources/oauthGrant';
import { applyActions } from '../../services/connectionHealth/store';
import type { ConnectionSourceKind, HealthObservation, HealthSource } from '../../services/connectionHealth/types';

const T0 = new Date();
const daysAgo = (n: number) => new Date(T0.getTime() - n * 86_400_000);
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const MANAGE = { resource: 'connected_apps', action: 'manage' };
const SEEDED_KEY = 'connection-health:kind:oauth_grant:seeded';
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

let P: string;
let u1: string; // partner admin holding connected_apps:manage, orgAccess all
let o1: string; // grant owner, no partner role
let clientId: string;
let emailSeq = 0;
const email = () => `ch-reconcile-${Date.now()}-${(emailSeq += 1)}@example.test`;

async function seedGrant(over: { createdAt?: Date; revokedAt?: Date | null; revokedReason?: string | null; clientId?: string } = {}) {
  const cid = over.clientId ?? clientId;
  const createdAt = over.createdAt ?? daysAgo(5);
  await asSystem(async () => {
    await db.insert(oauthClients).values({ id: cid, partnerId: null, metadata: { client_name: 'Test MCP Client' } }).onConflictDoNothing();
    await db.insert(oauthGrants).values({
      id: randomUUID(), accountId: o1, clientId: cid, partnerId: P, payload: {},
      createdAt, expiresAt: new Date(createdAt.getTime() + 14 * 86_400_000),
      revokedAt: over.revokedAt ?? null, revokedReason: over.revokedReason ?? null, revokedByUserId: null,
    });
  });
}

const incidents = () => asSystem(() => db.select().from(connectionHealthIncidents));
const noticesFor = (userIds: string[]) =>
  asSystem(() => db.select().from(userNotifications).where(inArray(userNotifications.userId, userIds)));

function obs(over: Partial<HealthObservation> = {}): HealthObservation {
  return {
    sourceKind: 'oauth_grant', sourceId: `${o1}:${clientId}`, partnerId: P, orgId: null, ownerUserId: o1,
    state: 'broken', severity: 'permanent', condition: 'grant_revoked_reuse', detail: null,
    displayName: 'Test MCP Client', fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
    viewPermission: { resource: 'connected_apps', action: 'read' }, repairPermission: MANAGE, observedAt: T0,
    ...over,
  };
}

// Production deps except the clock and Redis; the shared test Redis stands in for getRedis().
const reconcile = (now: Date, extra: Parameters<typeof runReconcile>[0] = {}) =>
  runReconcile({ redis: getTestRedis(), now: () => now, ...extra });

describe('runReconcile (end to end)', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    P = (await createPartner()).id;
    const orgA = (await createOrganization({ partnerId: P })).id;
    const role = await createRole({ scope: 'partner', partnerId: P, name: 'repairers' });
    await grantRolePermissions(role.id, [MANAGE]);
    u1 = (await createUser({ partnerId: P, email: email() })).id;
    await assignUserToPartner(u1, P, role.id, 'all');
    o1 = (await createUser({ partnerId: P, orgId: orgA, email: email() })).id;
    clientId = `client-${randomUUID()}`;
    await asSystem(() => db.delete(connectionHealthIncidents));
    const redis = getTestRedis();
    const keys = await redis.keys('connection-health:*');
    if (keys.length) await redis.del(...keys);
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse' });
  });

  it('reuse-revoked grant → incident + notices to owner and admin → re-consent → resolved after two runs → notices read', async () => {
    const redis = getTestRedis();
    await redis.set(SEEDED_KEY, '1');

    const first = await reconcile(T0);
    expect(first.kinds).toEqual([expect.objectContaining({ kind: 'oauth_grant', status: 'ok', opened: 1, observations: 1 })]);
    expect(first.notices).toEqual({ delivered: 1, failed: 0 });
    const opened = await noticesFor([u1, o1]);
    expect(opened.map((n) => [n.userId, n.link, n.read]).sort()).toEqual([
      [o1, '/account/connected-apps', false],
      [u1, '/settings/connected-apps', false],
    ].sort());

    await seedGrant({ createdAt: T0 }); // re-consent
    const healthy1 = await reconcile(plusMin(T0, 15));
    expect(healthy1.kinds[0]).toMatchObject({ status: 'ok', resolved: 0 });
    expect((await incidents())[0]).toMatchObject({ resolvedAt: null, healthyStreak: 1 });

    const healthy2 = await reconcile(plusMin(T0, 30));
    expect(healthy2.kinds[0]).toMatchObject({ status: 'ok', resolved: 1 });
    const [inc] = await incidents();
    expect(inc).toMatchObject({ resolution: 'recovered', pendingNotice: null });
    const after = await noticesFor([u1, o1]);
    expect(after).toHaveLength(2);
    expect(after.every((n) => n.read)).toBe(true);

    expect(await redis.get('connection-health:kind:oauth_grant:last-ok')).toBe(String(plusMin(T0, 30).getTime()));
    expect(await redis.get('connection-health:reconcile:heartbeat')).toBe(plusMin(T0, 30).toISOString());
    const ttl = await redis.ttl('connection-health:reconcile:heartbeat');
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('a run inside the interval skips the kind', async () => {
    await getTestRedis().set(SEEDED_KEY, '1');
    await reconcile(T0);
    const r = await reconcile(plusMin(T0, 5));
    expect(r.kinds).toEqual([expect.objectContaining({ kind: 'oauth_grant', status: 'skipped_not_due' })]);
  });

  it('a tracked incident whose grants were deleted is retired', async () => {
    await getTestRedis().set(SEEDED_KEY, '1');
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ sourceId: `${o1}:vanished-client` }), notify: false }], T0));
    await reconcile(plusMin(T0, 15));
    const [inc] = await asSystem(() => db.select().from(connectionHealthIncidents)
      .where(eq(connectionHealthIncidents.sourceId, `${o1}:vanished-client`)));
    expect(inc).toMatchObject({ resolution: 'retired' });
  });

  it('first run seeds without notices, records seeded, and the next new break notifies', async () => {
    const redis = getTestRedis();
    const first = await reconcile(T0);
    expect(first.kinds[0]).toMatchObject({ status: 'ok', opened: 1 });
    const seeded = await incidents();
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ pendingNotice: null });
    expect(await noticesFor([u1, o1])).toHaveLength(0);
    expect(await redis.get(SEEDED_KEY)).toBe('1');

    await seedGrant({ clientId: `client-${randomUUID()}`, revokedAt: daysAgo(0.5), revokedReason: 'provider-revoke-grant' });
    const second = await reconcile(plusMin(T0, 15));
    expect(second.kinds[0]).toMatchObject({ status: 'ok', opened: 1 });
    expect(await incidents()).toHaveLength(2);
    // Only the new incident notifies: one notice each for the admin and the owner.
    expect(await noticesFor([u1, o1])).toHaveLength(2);
  });

  it('without Redis it never seeds: the first run notifies', async () => {
    const r = await runReconcile({ redis: null, now: () => T0 });
    expect(r.kinds[0]).toMatchObject({ status: 'ok', opened: 1 });
    expect(await noticesFor([u1, o1])).toHaveLength(2);
  });

  it('a kind failing part-way through applying rolls back whole; incidents untouched and other kinds still run', async () => {
    const redis = getTestRedis();
    await redis.set(SEEDED_KEY, '1');
    // An open incident the failing run would retire (it is absent from the observations).
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ sourceId: `${o1}:tracked` }), notify: false }], T0));

    const failing: HealthSource = {
      kind: 'oauth_grant',
      intervalMinutes: 15,
      // A valid new break, then one whose display_name violates the table CHECK:
      // the first insert succeeds, the second fails, the transaction rolls back.
      observe: async () => [
        obs({ sourceId: `${o1}:new-a` }),
        obs({ sourceId: `${o1}:new-b`, displayName: 'x'.repeat(200) }),
      ],
    };
    let statementTimeout: string | null = null;
    const probe: HealthSource = {
      kind: 'probe_kind' as ConnectionSourceKind,
      intervalMinutes: 15,
      observe: async () => {
        const rows = (await db.execute(sql`SELECT current_setting('statement_timeout') AS v`)) as unknown as Array<{ v: string }>;
        statementTimeout = rows[0]!.v;
        return [];
      },
    };

    const r = await reconcile(plusMin(T0, 15), { sources: [failing, probe] });

    expect(r.kinds.map((k) => [k.kind, k.status])).toEqual([['oauth_grant', 'failed'], ['probe_kind', 'ok']]);
    expect(r.kinds[0]!.error).toBeTruthy();
    const rows = await incidents();
    expect(rows.map((x) => [x.sourceId, x.resolvedAt])).toEqual([[`${o1}:tracked`, null]]);
    expect(await redis.get('connection-health:kind:oauth_grant:failures')).toBe('1');
    expect(await redis.get('connection-health:kind:oauth_grant:last-ok')).toBeNull();
    expect(await redis.get('connection-health:kind:probe_kind:last-ok')).toBe(String(plusMin(T0, 15).getTime()));
    expect(statementTimeout).toBe('5s');
  });
});
