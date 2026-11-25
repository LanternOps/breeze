/**
 * Integration test — #12418 W01: `get_fleet_device_stats` with a typed filter,
 * a group-by and a paged device sample, against real Postgres as the
 * unprivileged `breeze_app` role (org-axis RLS genuinely enforced; the site
 * and device axes are app-layer scope the handler composes).
 *
 * Entry point: `executeTool` under `withDbAccessContext`, as in production.
 * Proven, for a partner-scoped, an org-scoped and a site-restricted caller:
 * the total, the grouped rows and the paged sample each contain only that
 * caller's devices; decommissioned, Quick Support (ephemeral) and parked
 * (unassigned-pool) devices are excluded even where the caller can read the
 * row (controls below prove each excluded row is readable and would match);
 * another partner's device is never counted. Nothing is stubbed.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

import type { DbAccessContext } from '../../db';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devicePatches, devices, patches, softwareInventory } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { FilterQueryTimeoutError, withFilterStatementTimeout } from '../../services/filterEngine';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const TOOL = 'get_fleet_device_stats';
const AI_SESSION_ID = randomUUID();

function makeAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; scope?: 'organization' | 'partner';
  allowedSiteIds?: string[]; allowedDeviceIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: scope === 'partner' ? 'all' : undefined,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    allowedDeviceIds: opts.allowedDeviceIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID },
  } as unknown as AuthContext;
}

type Who = 'partner' | 'org' | 'site' | 'noSites' | 'deviceBound' | 'otherPartner';

interface Fixture {
  partnerId: string; orgA: string; orgB: string; holding: string; orgC: string;
  s1: string; s2: string; sb: string;
  w1: string; w2: string; l1: string; d1: string; e1: string; b1: string; p1: string; c1: string;
  wide: string; groupB: string;
  auth: Record<Who, AuthContext>;
}

const TAG = randomUUID().slice(0, 6);

async function seedDevice(v: {
  orgId: string; siteId: string; name: string; osType?: 'windows' | 'macos' | 'linux';
  status?: 'online' | 'offline' | 'decommissioned'; isEphemeral?: boolean; parked?: boolean;
  extra?: Partial<typeof devices.$inferInsert>;
}): Promise<string> {
  // Only enrollment admission may create a device in a holding org.
  return getTestDb().transaction(async (tx) => {
    if (v.parked) await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [row] = await tx.insert(devices).values({
      orgId: v.orgId, siteId: v.siteId, agentId: `fleet-${randomUUID()}`, hostname: `${v.name}-${TAG}`,
      osType: v.osType ?? 'windows', osVersion: '10.0.22631', architecture: 'amd64', agentVersion: '1.0.0',
      status: v.status ?? 'online', isEphemeral: v.isEphemeral ?? false, ...v.extra,
    }).returning({ id: devices.id });
    return row!.id;
  });
}

async function seedSoftware(orgId: string, deviceId: string, name: string, version: string): Promise<void> {
  await getTestDb().insert(softwareInventory).values({ orgId, deviceId, name, version });
}

async function seedFixture(): Promise<Fixture> {
  const db0 = getTestDb();
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = (await createOrganization({ partnerId: partner.id }))!;
  const orgB = (await createOrganization({ partnerId: partner.id }))!;
  const holding = (await createOrganization({ partnerId: partner.id, name: 'Holding', type: 'unassigned_pool' }))!;
  const orgC = (await createOrganization({ partnerId: otherPartner.id }))!;
  const s1 = (await createSite({ orgId: orgA.id, name: 'Site 1' }))!;
  const s2 = (await createSite({ orgId: orgA.id, name: 'Site 2' }))!;
  const sb = (await createSite({ orgId: orgB.id, name: 'Site B' }))!;
  const sh = (await createSite({ orgId: holding.id, name: 'Holding site' }))!;
  const sc = (await createSite({ orgId: orgC.id, name: 'Site C' }))!;
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `fleet-${randomUUID()}@example.com` });
  const otherUser = await createUser({ partnerId: otherPartner.id, orgId: orgC.id, email: `fleet-${randomUUID()}@example.com` });

  const now = new Date();
  const w1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'w1', extra: { tags: ['pci'], lastSeenAt: now } });
  const w2 = await seedDevice({
    orgId: orgA.id, siteId: s2.id, name: 'w2', status: 'offline',
    extra: { pendingReboot: true, lastSeenAt: new Date(now.getTime() - 40 * 86_400_000) },
  });
  // l1 has never been seen (lastSeenAt NULL).
  const l1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'l1', osType: 'linux', extra: { osVersion: '22.04', agentVersion: '2.0.0' } });
  const d1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'd1', status: 'decommissioned' });
  const e1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'e1', isEphemeral: true });
  const b1 = await seedDevice({ orgId: orgB.id, siteId: sb.id, name: 'b1' });
  const p1 = await seedDevice({ orgId: holding.id, siteId: sh.id, name: 'p1', parked: true });
  const c1 = await seedDevice({ orgId: orgC.id, siteId: sc.id, name: 'c1' });

  // Two 7-Zip rows on w1: the count must still be one device.
  await seedSoftware(orgA.id, w1, '7-Zip', '23.01');
  await seedSoftware(orgA.id, w1, '7-Zip', '22.01');
  for (const [orgId, id] of [[orgA.id, d1], [orgA.id, e1], [orgB.id, b1], [holding.id, p1], [orgC.id, c1]] as const) {
    await seedSoftware(orgId, id, '7-Zip', '24.08');
  }
  // A partner-wide group whose members live in two orgs, and an org-B group.
  const [wide] = await db0.insert(deviceGroups).values({ orgId: null, partnerId: partner.id, name: 'Wide' }).returning({ id: deviceGroups.id });
  const [groupB] = await db0.insert(deviceGroups).values({ orgId: orgB.id, name: 'Group B' }).returning({ id: deviceGroups.id });
  await db0.insert(deviceGroupMemberships).values([
    { groupId: wide!.id, deviceId: w1, orgId: orgA.id },
    { groupId: wide!.id, deviceId: b1, orgId: orgB.id },
    { groupId: groupB!.id, deviceId: b1, orgId: orgB.id },
  ]);
  const [patch] = await db0.insert(patches).values({
    source: 'microsoft', externalId: `KB-${randomUUID()}`, vendor: 'Microsoft', title: `Update ${TAG}`,
    severity: 'critical', requiresReboot: false, releaseDate: '2026-01-01',
  }).returning({ id: patches.id });
  await db0.insert(devicePatches).values({ deviceId: w2, orgId: orgA.id, patchId: patch!.id, status: 'pending' });

  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, holding: holding.id, orgC: orgC.id,
    s1: s1.id, s2: s2.id, sb: sb.id, w1, w2, l1, d1, e1, b1, p1, c1, wide: wide!.id, groupB: groupB!.id,
    auth: {
      // The holding org is in the partner caller's accessible set on purpose:
      // RLS lets it read p1, so only the parked exclusion keeps p1 out.
      partner: makeAuth({ ...base, orgIds: [orgA.id, orgB.id, holding.id], scope: 'partner' }),
      org: makeAuth({ ...base, orgIds: [orgA.id] }),
      site: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [s1.id] }),
      noSites: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [] }),
      deviceBound: makeAuth({ ...base, orgIds: [orgA.id], allowedDeviceIds: [w2] }),
      otherPartner: makeAuth({ userId: otherUser.id, partnerId: otherPartner.id, orgIds: [orgC.id] }),
    },
  };
}

function ctxFor(auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId!, userId: auth.user.id,
  });
}

async function run(auth: AuthContext, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(ctxFor(auth), () => executeTool(TOOL, input, auth));
  return JSON.parse(raw) as Record<string, any>;
}

const ids = (body: Record<string, any>) => (body.devices as Array<{ id: string }>).map((d) => d.id);

describe('get_fleet_device_stats typed filter against real Postgres (#12418 W01)', () => {
  let f: Fixture;
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    f = await seedFixture();
  });

  runDb('controls: every excluded device is readable by the partner caller and carries 7-Zip', async () => {
    // Without these, the exclusion assertions below could pass vacuously.
    const visible = await withDbAccessContext(ctxFor(f.auth.partner), () =>
      db.select({ id: devices.id }).from(devices).where(inArray(devices.id, [f.d1, f.e1, f.p1, f.c1])));
    expect(visible.map((r) => r.id).sort()).toEqual([f.d1, f.e1, f.p1].sort());
    const withZip = await withSystemDbAccessContext(() =>
      db.selectDistinct({ id: softwareInventory.deviceId }).from(softwareInventory).where(eq(softwareInventory.name, '7-Zip')));
    expect(withZip).toHaveLength(6);
  });

  runDb('partner caller: counts the filtered set once per device and excludes decommissioned, ephemeral, parked and other-partner devices', async () => {
    const body = await run(f.auth.partner, { filter: { softwareInstalled: '7-Zip' }, groupBy: 'siteId' });
    expect(body.error).toBeUndefined();
    expect(body.total).toBe(2);
    expect(body.byStatus).toEqual({ online: 2 });
    expect(ids(body)).toEqual([f.b1, f.w1]); // hostname order: b1-…, w1-…
    expect(body.groups).toEqual({
      by: 'siteId',
      rows: [{ key: f.s1, label: 'Site 1', count: 1 }, { key: f.sb, label: 'Site B', count: 1 }].sort((a, b) => (a.key < b.key ? -1 : 1)),
      otherCount: 0,
    });
    expect(body.filter).toEqual({ fieldsUsed: ['software.installed'], executionRefusedFields: ['software.installed'] });
    expect(body).toMatchObject({ showing: 2, hasMore: false, totalMode: 'exact', nextCursor: null });
  });

  runDb('partner caller: unfiltered group-by never counts a decommissioned, ephemeral or parked device', async () => {
    const body = await run(f.auth.partner, { groupBy: 'status' });
    // w1, w2, l1, b1.
    expect(body.total).toBe(4);
    expect(body.groups.rows).toEqual([{ key: 'online', count: 3 }, { key: 'offline', count: 1 }]);
    expect(body.devices).toBeUndefined();
  });

  runDb('org caller: groups windows devices by site with exact counts and site names', async () => {
    const body = await run(f.auth.org, { filter: { osType: 'windows' }, groupBy: 'siteId' });
    expect(body.total).toBe(2);
    expect(body.groups).toEqual({
      by: 'siteId',
      rows: [{ key: f.s1, label: 'Site 1', count: 1 }, { key: f.s2, label: 'Site 2', count: 1 }].sort((a, b) => (a.key < b.key ? -1 : 1)),
      otherCount: 0,
    });
    expect(ids(body)).toEqual([f.w1, f.w2]);
  });

  runDb('org caller: another org\'s site counts zero', async () => {
    const body = await run(f.auth.org, { filter: { siteId: f.sb } });
    expect(body).toMatchObject({ total: 0, devices: [], showing: 0 });
  });

  runDb('a site-restricted caller counts only its site in total, groups and sample', async () => {
    const body = await run(f.auth.site, { filter: { osType: 'windows' }, groupBy: 'siteId' });
    expect(body.total).toBe(1);
    expect(body.groups).toEqual({ by: 'siteId', rows: [{ key: f.s1, label: 'Site 1', count: 1 }], otherCount: 0 });
    expect(ids(body)).toEqual([f.w1]);
  });

  runDb('an empty site allowlist counts zero', async () => {
    const body = await run(f.auth.noSites, { filter: { osType: 'windows' }, groupBy: 'status' });
    expect(body.total).toBe(0);
    expect(body.groups).toEqual({ by: 'status', rows: [], otherCount: 0 });
    expect(body.devices).toEqual([]);
  });

  runDb('a device-bound run counts only its frozen set', async () => {
    const body = await run(f.auth.deviceBound, { filter: { osType: 'windows' }, groupBy: 'status' });
    expect(body.total).toBe(1);
    expect(body.groups.rows).toEqual([{ key: 'offline', count: 1 }]);
    expect(ids(body)).toEqual([f.w2]);
  });

  runDb('another partner\'s caller sees only its own device', async () => {
    const body = await run(f.auth.otherPartner, { filter: { softwareInstalled: '7-Zip' } });
    expect(body.total).toBe(1);
    expect(ids(body)).toEqual([f.c1]);
  });

  runDb('pending-patch filter matches w2 only', async () => {
    const body = await run(f.auth.org, { filter: { pendingPatches: true } });
    expect(body.total).toBe(1);
    expect(ids(body)).toEqual([f.w2]);
    expect(body.filter.executionRefusedFields).toEqual([]);
  });

  runDb('softwareVersionBelow matches an install below the version (w1 has 22.01)', async () => {
    const body = await run(f.auth.partner, { filter: { softwareVersionBelow: { name: '7-zip', version: '23' } } });
    expect(body.total).toBe(1);
    expect(ids(body)).toEqual([f.w1]);
  });

  runDb('the sample pages with a cursor while the total stays exact', async () => {
    const first = await run(f.auth.org, { filter: { osType: 'windows' }, limit: 1 });
    expect(first).toMatchObject({ total: 2, showing: 1, hasMore: true });
    expect(ids(first)).toEqual([f.w1]);
    const second = await run(f.auth.org, { filter: { osType: 'windows' }, limit: 1, cursor: first.nextCursor });
    expect(second).toMatchObject({ total: 2, showing: 1, offset: 1, hasMore: false, nextCursor: null });
    expect(ids(second)).toEqual([f.w2]);
  });

  runDb('without filter or groupBy the counts match the unchanged contract', async () => {
    const body = await run(f.auth.org, {});
    expect(body).toEqual({
      total: 3, online: 2, offline: 1, byStatus: { online: 2, offline: 1 }, migrationRequiredCount: 0, logShippingFailingCount: 0,
    });
  });

  runDb('groupBy without a filter still honours the site axis and the device axis', async () => {
    const site = await run(f.auth.site, { groupBy: 'siteId' });
    expect(site.total).toBe(2); // w1, l1
    expect(site.groups).toEqual({ by: 'siteId', rows: [{ key: f.s1, label: 'Site 1', count: 2 }], otherCount: 0 });
    expect(site.devices).toBeUndefined();
    const bound = await run(f.auth.deviceBound, { groupBy: 'status' });
    expect(bound.total).toBe(1);
    expect(bound.groups.rows).toEqual([{ key: 'offline', count: 1 }]);
  });

  runDb('a site-restricted caller pointing the filter at a site it cannot see counts zero', async () => {
    const body = await run(f.auth.site, { filter: { siteId: f.s2 }, groupBy: 'siteId' });
    expect(body).toMatchObject({ total: 0, devices: [], groups: { rows: [], otherCount: 0 } });
    // Control: the org caller does see w2 at that site.
    expect(ids(await run(f.auth.org, { filter: { siteId: f.s2 } }))).toEqual([f.w2]);
  });

  runDb('a partner-wide group counts only the members inside the caller scope; another org\'s group counts zero', async () => {
    expect(ids(await run(f.auth.partner, { filter: { groupId: f.wide } }))).toEqual([f.b1, f.w1]);
    const org = await run(f.auth.org, { filter: { groupId: f.wide } });
    expect(org.total).toBe(1);
    expect(ids(org)).toEqual([f.w1]);
    expect((await run(f.auth.org, { filter: { groupId: f.groupB } })).total).toBe(0);
    // Control: the group is not empty for a caller that can see org B.
    expect(ids(await run(f.auth.partner, { filter: { groupId: f.groupB } }))).toEqual([f.b1]);
  });

  runDb('each remaining filter field matches the seeded device against real SQL', async () => {
    const one = async (filter: Record<string, unknown>) => ids(await run(f.auth.org, { filter }));
    expect(await one({ status: 'offline' })).toEqual([f.w2]);
    expect(await one({ osVersionContains: '22.04' })).toEqual([f.l1]);
    expect(await one({ hostnameContains: `w1-${TAG}` })).toEqual([f.w1]);
    expect(await one({ hostnameContains: '%' })).toEqual([]); // LIKE wildcard is literal
    expect(await one({ tags: ['pci'] })).toEqual([f.w1]);
    expect(await one({ agentVersion: '2.0.0' })).toEqual([f.l1]);
    expect(await one({ softwareMissing: '7-Zip' })).toEqual([f.l1, f.w2]);
    expect(await one({ rebootRequired: true })).toEqual([f.w2]);
    expect(await one({ criticalAlerts: false })).toEqual([f.l1, f.w1, f.w2]);
    // l1 was never seen: a NULL lastSeenAt does not match, as the description says.
    expect(await one({ lastSeenDaysOver: 30 })).toEqual([f.w2]);
  });

  runDb('groupBy architecture reports the stored value', async () => {
    const body = await run(f.auth.org, { groupBy: 'architecture' });
    expect(body.groups.rows).toEqual([{ key: 'amd64', count: 3 }]);
  });
});

// Strix finding on #12655: the filtered and grouped statements run under the
// filter engine's bounded statement_timeout, a cancellation becomes a bounded
// tool error, and the request transaction around the call stays usable.
describe('get_fleet_device_stats statement bound against real Postgres (#12655 Strix, #12656)', () => {
  let f: Fixture;
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    f = await seedFixture();
  });

  /**
   * Hold ACCESS EXCLUSIVE on `table` from a second connection while `fn` runs,
   * so any statement that reads `table` waits on the lock (a lock wait counts
   * toward statement_timeout). The lock is released after 4 s regardless, so
   * an unbounded statement makes the test fail instead of hanging.
   */
  async function withTableLocked<T>(table: 'software_inventory' | 'sites', fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = getTestDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`));
      locked();
      await Promise.race([released, new Promise((r) => setTimeout(r, 4_000))]);
    });
    await Promise.race([isLocked, holder]);
    try {
      return await fn();
    } finally {
      release();
      await holder;
    }
  }

  const currentTimeout = async () => {
    const res = await db.execute(sql`select current_setting('statement_timeout') as v`);
    return ((res as unknown as Array<{ v: string }>)[0] ?? (res as any).rows?.[0]).v;
  };

  async function callWhileLocked(auth: AuthContext, table: 'software_inventory' | 'sites', input: Record<string, unknown>) {
    return withTableLocked(table, () => withDbAccessContext(ctxFor(auth), async () => {
      const before = await currentTimeout();
      const started = Date.now();
      const raw = await executeTool(TOOL, input, auth);
      const elapsedMs = Date.now() - started;
      const after = await currentTimeout();
      // Another statement on the same request transaction, after the cancellation.
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(devices).where(eq(devices.id, f.w1));
      return { body: JSON.parse(raw) as Record<string, any>, raw, elapsedMs, before, after, followUp: row!.n };
    }));
  }

  function expectBoundedError(r: Awaited<ReturnType<typeof callWhileLocked>>) {
    expect(r.body).toEqual({ error: expect.stringMatching(/narrow the filter/i), code: 'filter_query_timeout' });
    // No SQL text, no tenant strings.
    expect(r.raw).not.toMatch(/select|software_inventory|statement_timeout|57014/i);
    for (const s of [TAG, f.orgA, f.partnerId, f.s1]) expect(r.raw).not.toContain(s);
    // Cancelled by the 500 ms bound, well before the 4 s lock release.
    expect(r.elapsedMs).toBeLessThan(3_000);
    // The request transaction survived: the follow-up read ran and the bound did not leak.
    expect(r.followUp).toBe(1);
    expect(r.after).toBe(r.before);
  }

  runDb('a software filter that outruns the bound returns the bounded tool error and the request context survives', async () => {
    const r = await callWhileLocked(f.auth.org, 'software_inventory', { filter: { softwareInstalled: '7-Zip' } });
    expectBoundedError(r);
    // Lock released: the same call answers normally, so nothing about the
    // cancellation persisted.
    const body = await run(f.auth.org, { filter: { softwareInstalled: '7-Zip' } });
    expect(body.total).toBe(1);
    expect(ids(body)).toEqual([f.w1]);
  });

  runDb('a groupBy-only breakdown is bounded too', async () => {
    const r = await callWhileLocked(f.auth.org, 'sites', { groupBy: 'siteId' });
    expectBoundedError(r);
  });

  runDb('the unfiltered, ungrouped count never reads the locked tables and is unchanged', async () => {
    const r = await callWhileLocked(f.auth.org, 'sites', {});
    expect(r.body).toMatchObject({ total: 3, online: 2, offline: 1 });
    expect(r.after).toBe(r.before);
  });

  runDb('withFilterStatementTimeout cancels a slow statement under a test-only bound, restores statement_timeout, keeps the request transaction usable', async () => {
    await withDbAccessContext(ctxFor(f.auth.org), async () => {
      const before = await currentTimeout();
      await expect(
        withFilterStatementTimeout((tx) => tx.execute(sql`select pg_sleep(2)`), { timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(FilterQueryTimeoutError);
      expect(await currentTimeout()).toBe(before);
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(devices).where(eq(devices.id, f.w1));
      expect(row!.n).toBe(1);
      // A statement inside the bound that finishes in time is unaffected.
      const ok = await withFilterStatementTimeout((tx) => tx.execute(sql`select 1 as one`), { timeoutMs: 1_000 });
      expect(ok).toBeTruthy();
    });
  });
});
