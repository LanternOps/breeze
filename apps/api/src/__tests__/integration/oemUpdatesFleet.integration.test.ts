/**
 * The Vendor updates fleet view and its overdue alerts against real Postgres and RLS
 * (#11074, W09 of #11065): who sees which devices through the real auth stack, the
 * exclusions on real rows, a partner-wide link read by an org caller, a real
 * 10,000-device scope, and the alert lifecycle through the real createAlert.
 *
 * Gates are closed in code until the lab wave, so the lab override opens them for the
 * seeded devices. The arming gate is a write-path rule, so the settings go in directly.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alertRules,
  alerts,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
  organizationUsers,
} from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { oemUpdatesFleetRoutes } from '../../routes/oemUpdates/fleet';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { runOemOverdueSweep } from '../../services/oemUpdates/overdueSweep';
import { clearPermissionCache } from '../../services/permissions';
import { createOrganization, createPartner, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const LONG_AGO = new Date('2024-01-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = ['first', 'second', 'third', 'fourth', 'last'] as const;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** A UTC schedule with no catch-up nights whose one night was three days ago, so any clock is past it. */
function schedulePast(now = new Date()) {
  const anchor = new Date(now.getTime() - 3 * DAY_MS);
  return {
    weekOfMonth: WEEKS[Math.min(Math.floor((anchor.getUTCDate() - 1) / 7), 4)]!,
    dayOfWeek: DAYS[anchor.getUTCDay()]!,
    windowStart: '01:00',
    windowHours: 1,
  };
}

function armedSettings(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    schedule: schedulePast(),
    catchUpNights: 0,
    reboot: 'overnight',
    vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
    ...overrides,
  };
}

async function seedDevice(orgId: string, siteId: string, overrides: Partial<typeof devices.$inferInsert> = {}) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `fleet-${randomUUID()}`,
    hostname: `fleet-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.127.0',
    status: 'online',
    enrolledAt: LONG_AGO,
    ...overrides,
  }).returning();
  await getTestDb().insert(deviceHardware).values({ deviceId: device!.id, orgId, manufacturer: 'Dell Inc.', model: 'Latitude 7420' });
  return device!;
}

/** A policy armed long before its occurrence's last night, unless told otherwise. */
async function armPolicy(
  owner: { orgId: string } | { partnerId: string },
  target: { level: 'organization' | 'partner'; id: string },
  options: { settings?: Record<string, unknown>; armedAt?: Date } = {},
) {
  const armedAt = options.armedAt ?? LONG_AGO;
  const [policy] = await getTestDb().insert(configurationPolicies).values({
    name: `Vendor updates ${randomUUID().slice(0, 8)}`,
    status: 'active',
    ...('orgId' in owner ? { orgId: owner.orgId } : { partnerId: owner.partnerId }),
  } as typeof configurationPolicies.$inferInsert).returning();
  await getTestDb().insert(configPolicyFeatureLinks).values({
    configPolicyId: policy!.id,
    featureType: 'oem_updates',
    inlineSettings: options.settings ?? armedSettings(),
    createdAt: armedAt,
    updatedAt: armedAt,
  });
  await getTestDb().insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: target.level,
    targetId: target.id,
    createdAt: armedAt,
  });
}

function openGatesFor(...deviceIds: string[]) {
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', deviceIds.join(','));
}

const payloadFor = (env: TestEnvironment, scope: 'organization' | 'partner'): Omit<TokenPayload, 'type'> => ({
  sub: env.user.id,
  email: env.user.email,
  roleId: env.role.id,
  orgId: scope === 'organization' ? env.organization.id : null,
  partnerId: env.partner.id,
  scope,
  mfa: true,
  aep: 1,
  mep: 1,
  sid: randomUUID(),
});

describe('#11074 GET /oem-updates/fleet', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/oem-updates', oemUpdatesFleetRoutes);
  });

  afterEach(() => vi.unstubAllEnvs());

  async function fleet(token: string, query = ''): Promise<{ status: number; body: any }> {
    const response = await app.request(`/oem-updates/fleet${query}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  }

  const ids = (body: any): string[] => body.devices.map((device: any) => device.deviceId).sort();

  runDb('a partner caller sees its orgs and no other partner\'s', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const secondOrg = await createOrganization({ partnerId: env.partner.id });
    const a = await seedDevice(env.organization.id, env.site.id);
    const b = await seedDevice(secondOrg.id, (await createSite({ orgId: secondOrg.id })).id);

    const stranger = await createPartner();
    const strangerOrg = await createOrganization({ partnerId: stranger.id });
    await seedDevice(strangerOrg.id, (await createSite({ orgId: strangerOrg.id })).id);

    const { status, body } = await fleet(await createAccessToken(payloadFor(env, 'partner')));

    expect(status).toBe(200);
    expect(ids(body)).toEqual([a.id, b.id].sort());
    expect(body.total).toBe(2);
    expect(body.counts.not_managed).toBe(2);
  });

  runDb('an org caller sees its own org, and is refused another', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const own = await seedDevice(env.organization.id, env.site.id);
    const sibling = await createOrganization({ partnerId: env.partner.id });
    await seedDevice(sibling.id, (await createSite({ orgId: sibling.id })).id);
    const token = await createAccessToken(payloadFor(env, 'organization'));

    const { body } = await fleet(token);
    expect(ids(body)).toEqual([own.id]);

    expect((await fleet(token, `?orgId=${sibling.id}`)).status).toBe(403);
  });

  runDb('a partner caller can narrow to one org', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const secondOrg = await createOrganization({ partnerId: env.partner.id });
    await seedDevice(env.organization.id, env.site.id);
    const b = await seedDevice(secondOrg.id, (await createSite({ orgId: secondOrg.id })).id);

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'partner')), `?orgId=${secondOrg.id}`);

    expect(ids(body)).toEqual([b.id]);
    expect(body.counts.not_managed).toBe(1);
  });

  runDb('a site-restricted user sees only their sites, in the list and the counts', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const otherSite = await createSite({ orgId: env.organization.id });
    const mine = await seedDevice(env.organization.id, env.site.id);
    await seedDevice(env.organization.id, otherSite.id);
    await getTestDb().update(organizationUsers).set({ siteIds: [env.site.id] }).where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
    await clearPermissionCache(env.user.id);

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'organization')));

    expect(ids(body)).toEqual([mine.id]);
    expect(body.counts.not_managed).toBe(1);
  });

  runDb('leaves out Quick Support, parked and decommissioned devices', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const kept = await seedDevice(env.organization.id, env.site.id);
    await seedDevice(env.organization.id, env.site.id, { isEphemeral: true });
    await seedDevice(env.organization.id, env.site.id, { status: 'decommissioned' });
    const pool = await createOrganization({ partnerId: env.partner.id, type: 'unassigned_pool' });
    const poolSite = await createSite({ orgId: pool.id });
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      await db.insert(devices).values({
        orgId: pool.id,
        siteId: poolSite.id,
        agentId: `fleet-parked-${randomUUID()}`,
        hostname: 'fleet-parked',
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '0.127.0',
        status: 'online',
      });
    });

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'partner')));

    expect(ids(body)).toEqual([kept.id]);
  });

  runDb('an org caller reads a partner-wide link through RLS, and the state follows', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const device = await seedDevice(env.organization.id, env.site.id);
    openGatesFor(device.id);
    await armPolicy({ partnerId: env.partner.id }, { level: 'partner', id: env.partner.id });

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'organization')));

    expect(body.devices[0].lane).toBe('dell');
    expect(body.devices[0].displayState).toBe('overdue');
    expect(body.counts.overdue).toBe(1);
  });

  runDb('group assignments resolve through the inline memberships', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const inGroup = await seedDevice(env.organization.id, env.site.id);
    const outside = await seedDevice(env.organization.id, env.site.id);
    openGatesFor(inGroup.id, outside.id);

    const groupId = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_groups (id, org_id, name) VALUES (${groupId}::uuid, ${env.organization.id}::uuid, 'Fleet test')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${inGroup.id}::uuid, ${groupId}::uuid, ${env.organization.id}::uuid)
    `));
    const [policy] = await getTestDb().insert(configurationPolicies).values({
      name: `Group ${randomUUID().slice(0, 8)}`, status: 'active', orgId: env.organization.id,
    } as typeof configurationPolicies.$inferInsert).returning();
    await getTestDb().insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'oem_updates', inlineSettings: armedSettings(), createdAt: LONG_AGO, updatedAt: LONG_AGO,
    });
    await getTestDb().insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'device_group', targetId: groupId, createdAt: LONG_AGO,
    });

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'partner')));

    const stateOf = (id: string) => body.devices.find((row: any) => row.deviceId === id).displayState;
    expect(stateOf(inGroup.id)).toBe('overdue');
    expect(stateOf(outside.id)).toBe('not_managed');
  });

  runDb('a policy armed today does not turn the fleet overdue for last week', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const device = await seedDevice(env.organization.id, env.site.id);
    openGatesFor(device.id);
    await armPolicy({ orgId: env.organization.id }, { level: 'organization', id: env.organization.id }, { armedAt: new Date() });

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'partner')));

    expect(body.devices[0].displayState).toBe('not_managed');
  });

  runDb('10,000 devices: correct counts in bounded time, and a small org stays on the org index', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const small = await createOrganization({ partnerId: env.partner.id });
    const smallSite = await createSite({ orgId: small.id });
    const smallDevice = await seedDevice(small.id, smallSite.id);

    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, enrolled_at)
      SELECT ${env.organization.id}::uuid, ${env.site.id}::uuid, 'fleet-bulk-' || n, 'bulk-' || lpad(n::text, 5, '0'),
             'windows', '11', 'amd64', '0.127.0', 'online', ${LONG_AGO.toISOString()}::timestamp
      FROM generate_series(1, 10000) AS n
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_hardware (device_id, org_id, manufacturer, model)
      SELECT id, org_id, 'Dell Inc.', 'Latitude 7420' FROM devices WHERE org_id = ${env.organization.id}::uuid
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_oem_update_status (device_id, org_id, applicability, lane, last_outcome, occurrence_key, last_success_at)
      SELECT id, org_id, 'applicable', 'dell', 'success', '2020-01', ${LONG_AGO.toISOString()}::timestamptz
      FROM devices WHERE org_id = ${env.organization.id}::uuid
    `));
    await withSystemDbAccessContext(() => db.execute(sql`ANALYZE devices`));
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    await armPolicy({ partnerId: env.partner.id }, { level: 'partner', id: env.partner.id });

    const token = await createAccessToken(payloadFor(env, 'partner'));
    const startedAt = performance.now();
    const { status, body } = await fleet(token, `?orgId=${env.organization.id}&limit=50`);
    const elapsedMs = performance.now() - startedAt;

    expect(status).toBe(200);
    expect(body.total).toBe(10_000);
    expect(body.devices).toHaveLength(50);
    expect(Object.values<number>(body.counts).reduce((sum, count) => sum + count, 0)).toBe(10_000);
    // The query count itself is pinned in routes/oemUpdates/fleet.test.ts, where db.select
    // can be counted. Here, a per-device walk would not finish in this time: it would be
    // several queries for each of 10,000 devices.
    expect(elapsedMs).toBeLessThan(30_000);
    process.stderr.write(`[oemUpdatesFleet] 10,000 devices in ${Math.round(elapsedMs)} ms\n`);

    // The same shape of read for the small org: the plan starts from its org id, not the table.
    const plan = await withSystemDbAccessContext(() => db.execute(sql`
      EXPLAIN SELECT d.id, d.hostname
      FROM devices d
      INNER JOIN organizations o ON o.id = d.org_id
      LEFT JOIN device_oem_update_status s ON s.device_id = d.id
      WHERE d.is_ephemeral = false AND d.status <> 'decommissioned' AND d.org_id = ${small.id}::uuid
      ORDER BY lower(d.hostname), d.id
    `)) as unknown as Array<{ 'QUERY PLAN': string }>;
    const text = plan.map((line) => line['QUERY PLAN']).join('\n');
    expect(text, text).not.toMatch(/Seq Scan on devices/);
    expect(smallDevice.id).toBeTruthy();
  }, 120_000);
});

describe('#11074 overdue alerts, through the real createAlert', () => {
  afterEach(() => vi.unstubAllEnvs());

  const openAlerts = (deviceId: string) => withSystemDbAccessContext(() => db
    .select({ id: alerts.id, status: alerts.status, name: alertRules.name, context: alerts.context })
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .where(eq(alerts.deviceId, deviceId)));

  async function overdueDevice(env: TestEnvironment) {
    const device = await seedDevice(env.organization.id, env.site.id);
    openGatesFor(device.id);
    await armPolicy({ orgId: env.organization.id }, { level: 'organization', id: env.organization.id });
    await getTestDb().insert(deviceOemUpdateStatus).values({
      deviceId: device.id,
      orgId: env.organization.id,
      applicability: 'applicable',
      lane: 'dell',
      lastOutcome: 'success',
      occurrenceKey: '2020-01',
      lastSuccessAt: LONG_AGO,
    });
    return device;
  }

  runDb('raises once in the device org, stays once after a tech closes it, and a good run resolves an open one', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const device = await overdueDevice(env);

    await runOemOverdueSweep(new Date());
    const first = await openAlerts(device.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.name).toBe('Vendor update: device overdue');
    expect(first[0]!.status).toBe('active');

    // The rule landed in the device's org, under the built-in source.
    const [rule] = await withSystemDbAccessContext(() => db
      .select({ orgId: alertRules.orgId })
      .from(alertRules)
      .where(and(eq(alertRules.orgId, env.organization.id), eq(alertRules.name, 'Vendor update: device overdue'))));
    expect(rule?.orgId).toBe(env.organization.id);

    await runOemOverdueSweep(new Date());
    expect(await openAlerts(device.id)).toHaveLength(1);

    // A good run after the alert.
    await getTestDb().update(deviceOemUpdateStatus)
      .set({ lastSuccessAt: new Date(Date.now() + 60_000) })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));
    await runOemOverdueSweep(new Date());
    const settled = await openAlerts(device.id);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('resolved');

    // Still reading overdue would not raise it again this occurrence.
    await getTestDb().update(deviceOemUpdateStatus)
      .set({ lastSuccessAt: LONG_AGO })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));
    await runOemOverdueSweep(new Date());
    expect(await openAlerts(device.id)).toHaveLength(1);
  });

  runDb('a held restart raises its own alert, and clearing it resolves that alert', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const device = await overdueDevice(env);
    await getTestDb().update(deviceOemUpdateStatus)
      .set({ rebootPendingSince: new Date(Date.now() - 4 * DAY_MS), occurrenceKey: null, lastSuccessAt: null })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));

    await runOemOverdueSweep(new Date());

    const raised = await openAlerts(device.id);
    expect(raised.map((alert) => alert.name)).toEqual(['Vendor update: restart overdue']);

    await getTestDb().update(deviceOemUpdateStatus)
      .set({ rebootPendingSince: null })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));
    await runOemOverdueSweep(new Date());

    const afterRestart = await openAlerts(device.id);
    expect(afterRestart.find((alert) => alert.name === 'Vendor update: restart overdue')?.status).toBe('resolved');
  });

  runDb('with the flag off, nothing goes overdue and nothing is raised', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const device = await overdueDevice(env);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');

    await runOemOverdueSweep(new Date());

    expect(await openAlerts(device.id)).toEqual([]);
  });
});
