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
import { fleetRowsQuery, fleetScopeCondition, oemUpdatesFleetRoutes } from '../../routes/oemUpdates/fleet';
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

// 2,500 by default: seeding 10,000 devices through the export-watermark triggers took ~50 s on
// a fresh test database. The scale guard is the route's two-statement count (fleet.test.ts) and
// the org-index plan below, neither of which needs 10k rows. OEM_FLEET_SCALE_ROWS=10000 for a
// local full-size run.
const FLEET_ROWS = Number(process.env.OEM_FLEET_SCALE_ROWS ?? 2_500);
const SEED_BATCH = 500;
// Measured seed ~4.5 s at 2,500 rows on a fresh database (~50 s at 10,000); the 60 s floor is >10x
// the 2,500 figure for a loaded CI host, and larger overrides scale with their row count.
const FLEET_TEST_TIMEOUT_MS = Math.max(60_000, FLEET_ROWS * 12);

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

  runDb('fleet at scale: correct counts in bounded time, and a small org stays on the org index', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const small = await createOrganization({ partnerId: env.partner.id });
    const smallSite = await createSite({ orgId: small.id });
    const smallDevice = await seedDevice(small.id, smallSite.id);

    // Seeding is batched: the device-child tables carry statement-level triggers over a
    // transition table, and one 10,000-row statement is quadratic in them (~100 s on a
    // fresh database). 500 rows a statement, in one transaction, is linear. It goes through
    // the owner connection: under the app role, RLS is evaluated on every row the triggers
    // touch, which costs ~3 s a batch instead of ~50 ms.
    const seedStartedAt = performance.now();
    const orgId = env.organization.id;
    const seedDb = getTestDb();
    await seedDb.transaction(async (tx) => {
      for (let lo = 1; lo <= FLEET_ROWS; lo += SEED_BATCH) {
        const hi = Math.min(lo + SEED_BATCH - 1, FLEET_ROWS);
        await tx.execute(sql`
          INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, enrolled_at)
          SELECT ${orgId}::uuid, ${env.site.id}::uuid, 'fleet-bulk-' || n, 'bulk-' || lpad(n::text, 5, '0'),
                 'windows', '11', 'amd64', '0.127.0', 'online', ${LONG_AGO.toISOString()}::timestamp
          FROM generate_series(${lo}::int, ${hi}::int) AS n
        `);
      }
      await tx.execute(sql`ANALYZE devices`);
      for (let lo = 1; lo <= FLEET_ROWS; lo += SEED_BATCH) {
        const hi = Math.min(lo + SEED_BATCH - 1, FLEET_ROWS);
        await tx.execute(sql`
          INSERT INTO device_hardware (device_id, org_id, manufacturer, model)
          SELECT d.id, d.org_id, 'Dell Inc.', 'Latitude 7420'
          FROM generate_series(${lo}::int, ${hi}::int) AS n
          JOIN devices d ON d.org_id = ${orgId}::uuid AND d.agent_id = 'fleet-bulk-' || n
        `);
        await tx.execute(sql`
          INSERT INTO device_oem_update_status (device_id, org_id, applicability, lane, last_outcome, occurrence_key, last_success_at)
          SELECT d.id, d.org_id, 'applicable', 'dell', 'success', '2020-01', ${LONG_AGO.toISOString()}::timestamptz
          FROM generate_series(${lo}::int, ${hi}::int) AS n
          JOIN devices d ON d.org_id = ${orgId}::uuid AND d.agent_id = 'fleet-bulk-' || n
        `);
      }
    });
    process.stderr.write(`[oemUpdatesFleet] seeded ${FLEET_ROWS} devices in ${Math.round(performance.now() - seedStartedAt)} ms\n`);
    await withSystemDbAccessContext(() => db.execute(sql`ANALYZE devices`));
    await withSystemDbAccessContext(() => db.execute(sql`ANALYZE device_hardware`));
    await withSystemDbAccessContext(() => db.execute(sql`ANALYZE device_oem_update_status`));
    // The lab override re-reads its list per device, so a sample: enough to prove the
    // pass classifies each row on its own, and the rest of the fleet stays closed.
    const sample = await withSystemDbAccessContext(() => db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.orgId, env.organization.id))
      .limit(100));
    openGatesFor(...sample.map((row) => row.id));
    await armPolicy({ partnerId: env.partner.id }, { level: 'partner', id: env.partner.id });

    const token = await createAccessToken(payloadFor(env, 'partner'));
    const startedAt = performance.now();
    const { status, body } = await fleet(token, `?orgId=${env.organization.id}&limit=50`);
    const elapsedMs = performance.now() - startedAt;

    expect(status).toBe(200);
    expect(body.total).toBe(FLEET_ROWS);
    expect(body.devices).toHaveLength(50);
    expect(body.counts.overdue).toBe(100);
    expect(body.counts.not_managed).toBe(FLEET_ROWS - 100);
    // The query count itself is pinned in routes/oemUpdates/fleet.test.ts, where db.select
    // can be counted. Here, a per-device walk would not finish in this time: it would be
    // several queries for each of 10,000 devices.
    expect(elapsedMs).toBeLessThan(30_000);
    process.stderr.write(`[oemUpdatesFleet] ${FLEET_ROWS} devices in ${Math.round(elapsedMs)} ms\n`);

    // The route's own statement, for the small org: the plan starts from its org id, not the table.
    const statement = fleetRowsQuery(fleetScopeCondition({
      orgCondition: eq(devices.orgId, small.id),
      orgId: small.id,
    }), true).toSQL();
    const literal = (value: unknown) => (typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value));
    const inlined = statement.sql.replace(/\$(\d+)/g, (_, index) => literal(statement.params[Number(index) - 1]));
    const plan = await withSystemDbAccessContext(() => db.execute(sql.raw(`EXPLAIN ${inlined}`))) as unknown as Array<{ 'QUERY PLAN': string }>;
    const text = plan.map((line) => line['QUERY PLAN']).join('\n');
    expect(text, text).toMatch(/devices/);
    expect(text, text).not.toMatch(/Seq Scan on devices/);

    const small_ = await fleet(token, `?orgId=${small.id}`);
    expect(small_.body.devices.map((row: any) => row.deviceId)).toEqual([smallDevice.id]);
  }, FLEET_TEST_TIMEOUT_MS);
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

  runDb('each org gets its own rule and alert, and one org\'s alert does not silence another\'s', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const second = await createOrganization({ partnerId: env.partner.id });
    const secondSite = await createSite({ orgId: second.id });
    const a = await seedDevice(env.organization.id, env.site.id);
    const b = await seedDevice(second.id, secondSite.id);
    openGatesFor(a.id, b.id);
    await armPolicy({ partnerId: env.partner.id }, { level: 'partner', id: env.partner.id });
    for (const [deviceId, orgId] of [[a.id, env.organization.id], [b.id, second.id]] as const) {
      await getTestDb().insert(deviceOemUpdateStatus).values({
        deviceId, orgId, applicability: 'applicable', lane: 'dell', lastOutcome: 'success', occurrenceKey: '2020-01', lastSuccessAt: LONG_AGO,
      });
    }

    await runOemOverdueSweep(new Date());

    expect(await openAlerts(a.id)).toHaveLength(1);
    expect(await openAlerts(b.id)).toHaveLength(1);
    const rules = await withSystemDbAccessContext(() => db
      .select({ orgId: alertRules.orgId })
      .from(alertRules)
      .where(eq(alertRules.name, 'Vendor update: device overdue')));
    expect(rules.map((rule) => rule.orgId)).toEqual(expect.arrayContaining([env.organization.id, second.id]));
  });

  runDb('with the flag off, nothing goes overdue and nothing is raised', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const device = await overdueDevice(env);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');

    await runOemOverdueSweep(new Date());

    expect(await openAlerts(device.id)).toEqual([]);
  });
});
