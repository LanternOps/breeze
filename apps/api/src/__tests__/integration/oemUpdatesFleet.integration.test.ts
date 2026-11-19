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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alertRules,
  alerts,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  deviceHardware,
  deviceOemPolicySide,
  deviceOemUpdateStatus,
  devices,
  organizations,
  organizationUsers,
  partners,
  sites,
} from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import {
  fleetPageQuery,
  fleetSummaryStatement,
  fleetScopeCondition,
  OEM_FLEET_PENDING_REFRESH_LIMIT,
  oemUpdatesFleetRoutes,
  type FleetRead,
} from '../../routes/oemUpdates/fleet';
import { effectiveTimezoneFrom } from '../../services/oemUpdates/candidates';
import { OEM_DISPLAY_STATES, type OemDisplayState } from '../../services/oemUpdates/displayState';
import { classifyOemDevice, oemOccurrenceMemo, oemOfferedLane, type OemDeviceFacts } from '../../services/oemUpdates/policySide';
import { oemGatesFingerprint, refreshOemPolicySide } from '../../services/oemUpdates/policySideStore';
import { resolveOemUpdatesLinksForDevices } from '../../services/oemUpdates/resolver';
import { clearDeviceCooldowns } from '../../services/alertCooldown';
import { CommandTypes } from '../../services/commandTypes';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { priorOemAlerts } from '../../services/oemUpdates/alerts';
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

/** Postgres's plan for a built statement, parameters inlined so it plans for these values. */
async function explain(statement: { sql: string; params: unknown[] }): Promise<string> {
  const literal = (value: unknown) => (typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value));
  const inlined = statement.sql.replace(/\$(\d+)/g, (_, index) => literal(statement.params[Number(index) - 1]));
  const plan = await withSystemDbAccessContext(() => db.execute(sql.raw(`EXPLAIN ${inlined}`))) as unknown as Array<{ 'QUERY PLAN': string }>;
  return plan.map((line) => line['QUERY PLAN']).join('\n');
}

/**
 * What the device section and the overdue alerts would say for these devices now: the
 * live rule over freshly read facts, with links from the batch resolver (a different
 * read path from the store's).
 */
async function liveStates(deviceIds: string[], now: Date): Promise<Map<string, OemDisplayState>> {
  const rows = await withSystemDbAccessContext(() => db
    .select({
      deviceId: devices.id,
      partnerId: organizations.partnerId,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      deviceRole: devices.deviceRole,
      enrolledAt: devices.enrolledAt,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
      statusLane: deviceOemUpdateStatus.lane,
      applicability: deviceOemUpdateStatus.applicability,
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
      occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
      attempts: deviceOemUpdateStatus.attempts,
      lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .leftJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    .where(inArray(devices.id, deviceIds)));
  const links = await withSystemDbAccessContext(() => resolveOemUpdatesLinksForDevices(deviceIds));
  const occurrenceOf = oemOccurrenceMemo(now);
  return new Map(rows.map((row) => {
    const facts = row as unknown as OemDeviceFacts;
    return [row.deviceId, classifyOemDevice({
      facts,
      lane: oemOfferedLane(facts),
      link: links.get(row.deviceId) ?? null,
      timezone: effectiveTimezoneFrom(row),
      now,
      occurrenceOf,
    }).state];
  }));
}

const FLEET_ROWS = 10_000;
// A wall-clock ceiling, not the guard: what keeps the route from reading the scope into
// the process is the statement and row counts below, which do not depend on the host.
// Most of what is left is the per-row RLS check on each table of the one pass (46 ms for
// it in system scope against ~350 ms under a partner context on a heavily loaded host,
// where the previous in-process route took 1.0-1.2 s on the same rows). Overridable;
// record the medians it prints.
const FLEET_LATENCY_BUDGET_MS = Number(process.env.OEM_FLEET_LATENCY_BUDGET_MS ?? 600);
const FLEET_TEST_TIMEOUT_MS = 120_000;
const HOUR_MS = 60 * 60 * 1000;
/** The scale case's seeded mix (see its status and policy-side inserts). */
const SEEDED_COUNTS = {
  up_to_date: 2_000,
  overdue: 2_000,
  failing: 1_000,
  waiting_for_reboot: 1_000,
  reboot_overdue: 1_000,
  not_supported: 500,
  not_managed: 2_500,
};

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

  runDb('fleet at 10,000 devices: two statements, under budget, counts agree with the rule', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const small = await createOrganization({ partnerId: env.partner.id });
    const smallSite = await createSite({ orgId: small.id });
    const smallDevice = await seedDevice(small.id, smallSite.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    const fingerprint = oemGatesFingerprint();

    // Seeded through the owner connection with replication-role triggers off: the
    // device-child export triggers (#11259) and the FK triggers are skipped, so 10,000
    // rows take seconds. Every row is consistent by construction.
    const seedStartedAt = performance.now();
    const orgId = env.organization.id;
    const seededAt = new Date();
    const at = (offsetMs: number) => new Date(seededAt.getTime() + offsetMs).toISOString();
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, enrolled_at)
        SELECT ${orgId}::uuid, ${env.site.id}::uuid, 'fleet-bulk-' || n, 'bulk-' || lpad(n::text, 5, '0'),
               'windows', '11', 'amd64', '0.127.0', 'online', ${LONG_AGO.toISOString()}::timestamp
        FROM generate_series(1, ${FLEET_ROWS}::int) AS n
      `);
      await tx.execute(sql`
        INSERT INTO device_hardware (device_id, org_id, manufacturer, model)
        SELECT d.id, d.org_id, 'Dell Inc.', 'Latitude 7420' FROM devices d WHERE d.org_id = ${orgId}::uuid
      `);
      // The mix, by device number: see SEEDED_COUNTS.
      await tx.execute(sql`
        INSERT INTO device_oem_update_status
          (device_id, org_id, applicability, lane, last_outcome, occurrence_key, attempts, last_success_at, reboot_pending_since)
        SELECT d.id, d.org_id,
          CASE WHEN g.n BETWEEN 7001 AND 7500 THEN 'not_supported' ELSE 'applicable' END,
          'dell',
          CASE WHEN g.n BETWEEN 4001 AND 5000 THEN 'failed' WHEN g.n BETWEEN 7001 AND 7500 THEN 'not_supported' ELSE 'success' END,
          CASE WHEN g.n BETWEEN 2001 AND 4000 THEN '2020-01' ELSE '2099-01' END,
          1,
          ${LONG_AGO.toISOString()}::timestamptz,
          CASE WHEN g.n BETWEEN 5001 AND 6000 THEN ${at(-HOUR_MS)}::timestamptz
               WHEN g.n BETWEEN 6001 AND 7000 THEN ${at(-4 * DAY_MS)}::timestamptz END
        FROM (SELECT d.id, d.org_id, substring(d.agent_id FROM 12)::int AS n FROM devices d WHERE d.org_id = ${orgId}::uuid) g
        JOIN devices d ON d.id = g.id
        WHERE g.n <= 7500
      `);
      // Devices 1-7500 are under an armed link whose occurrence (2099-01) is past its last
      // night for 2001-4000 only; 7501+ are offered no lane.
      await tx.execute(sql`
        INSERT INTO device_oem_policy_side
          (device_id, org_id, offered_lane, gates_fingerprint, link_id, link_enabled, reboot_mode,
           occurrence_key, last_night_start, past_last_night_at, refresh_after, managed_since, computed_at)
        SELECT g.id, g.org_id,
          CASE WHEN g.n <= 7500 THEN 'dell' END,
          ${fingerprint},
          CASE WHEN g.n <= 7500 THEN ${randomUUID()}::uuid END,
          g.n <= 7500,
          CASE WHEN g.n <= 7500 THEN 'overnight' END,
          CASE WHEN g.n <= 7500 THEN '2099-01' END,
          CASE WHEN g.n BETWEEN 2001 AND 4000 THEN ${at(-DAY_MS - HOUR_MS)}::timestamptz WHEN g.n <= 7500 THEN ${at(4 * DAY_MS)}::timestamptz END,
          CASE WHEN g.n BETWEEN 2001 AND 4000 THEN ${at(-DAY_MS)}::timestamptz WHEN g.n <= 7500 THEN ${at(5 * DAY_MS)}::timestamptz END,
          CASE WHEN g.n <= 7500 THEN ${at(20 * DAY_MS)}::timestamptz END,
          CASE WHEN g.n <= 7500 THEN ${LONG_AGO.toISOString()}::timestamptz END,
          now()
        FROM (SELECT d.id, d.org_id, substring(d.agent_id FROM 12)::int AS n FROM devices d WHERE d.org_id = ${orgId}::uuid) g
      `);
    });
    await getTestDb().execute(sql`ANALYZE devices, device_hardware, device_oem_update_status, device_oem_policy_side, organizations`);
    process.stderr.write(`[oemUpdatesFleet] seeded ${FLEET_ROWS} devices in ${Math.round(performance.now() - seedStartedAt)} ms\n`);

    const token = await createAccessToken(payloadFor(env, 'partner'));
    const urls = [
      `?orgId=${orgId}&limit=50`,
      `?orgId=${orgId}&state=failing`,
      `?orgId=${orgId}&lane=dell&offset=7450`,
    ];

    // Statements that read the fleet tables, through any session or transaction, and the
    // rows each one hands back to this process: two statements, and never the scope.
    type Seen = { sql: string; rows: number };
    let seen: Seen[] = [];
    const prepare = PostgresJsSession.prototype.prepareQuery;
    const prepared = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (
      this: PostgresJsSession<never, never, never>,
      ...args: Parameters<typeof prepare>
    ) {
      const query = prepare.apply(this, args);
      const execute = query.execute.bind(query);
      query.execute = (async (...executeArgs: Parameters<typeof execute>) => {
        const result = await execute(...executeArgs);
        seen.push({ sql: args[0].sql, rows: Array.isArray(result) ? result.length : 0 });
        return result;
      }) as typeof query.execute;
      return query;
    });
    try {
      for (const url of urls) {
        seen = [];
        const { status, body } = await fleet(token, url);
        expect(status, url).toBe(200);
        const fleetReads = seen.filter(({ sql: text }) => text.includes('"device_oem_policy_side"'));
        expect(fleetReads, url).toHaveLength(2);
        const limit = Number(new URLSearchParams(url).get('limit') ?? 50);
        for (const read of fleetReads) expect(read.rows, url).toBeLessThanOrEqual(limit + OEM_DISPLAY_STATES.length);
        expect(body.pendingRefresh, url).toBeUndefined();
      }
    } finally {
      prepared.mockRestore();
    }

    // Latency: one warm-up, then the median of five, per URL.
    const medians: Record<string, number> = {};
    for (const url of urls) {
      await fleet(token, url);
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const startedAt = performance.now();
        await fleet(token, url);
        samples.push(performance.now() - startedAt);
      }
      samples.sort((a, b) => a - b);
      medians[url] = Math.round(samples[2]!);
    }
    process.stderr.write(`[oemUpdatesFleet] ${FLEET_ROWS} devices, median ms per URL: ${JSON.stringify(medians)}\n`);
    for (const [url, median] of Object.entries(medians)) expect(median, url).toBeLessThan(FLEET_LATENCY_BUDGET_MS);

    // Counts are the seeded mix; the list pages and filters through the same rule.
    const first = await fleet(token, urls[0]!);
    expect(first.body.counts).toEqual(SEEDED_COUNTS);
    expect(first.body.total).toBe(FLEET_ROWS);
    expect(first.body.devices).toHaveLength(50);
    expect(first.body.devices[0].hostname).toBe('bulk-00001');
    const failing = await fleet(token, `?orgId=${orgId}&state=failing&limit=200&offset=900`);
    expect(failing.body.total).toBe(1_000);
    expect(failing.body.devices).toHaveLength(100);
    expect(failing.body.devices.every((device: any) => device.displayState === 'failing')).toBe(true);
    const dell = await fleet(token, urls[2]!);
    expect(dell.body.total).toBe(7_500);
    expect(dell.body.devices).toHaveLength(50);
    expect(Object.values<number>(dell.body.counts).reduce((sum, n) => sum + n, 0)).toBe(7_500);

    // Both statements for a small org start from its org id, not the table.
    const smallRead: FleetRead = {
      where: fleetScopeCondition({ orgCondition: eq(devices.orgId, small.id), orgId: small.id }),
      now: new Date(),
      flagOn: true,
      fingerprint,
    };
    for (const statement of [
      new PgDialect().sqlToQuery(fleetSummaryStatement(smallRead, { limit: 50, offset: 0 })),
      fleetPageQuery(smallRead, [smallDevice.id]).toSQL(),
    ]) {
      const text = await explain(statement);
      expect(text, text).toMatch(/devices/);
      expect(text, text).not.toMatch(/Seq Scan on devices/);
    }
    const smallFleet = await fleet(token, `?orgId=${small.id}`);
    expect(smallFleet.body.devices.map((row: any) => row.deviceId)).toEqual([smallDevice.id]);

    // End to end against the live rule: for a sample across every seeded group, the
    // worker's materialisation plus the SQL rule reads what classifyOemDevice reads
    // over the same facts and a real policy.
    const sample = await withSystemDbAccessContext(() => db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), sql`substring(${devices.agentId} FROM 12)::int % 50 = 0`)));
    expect(sample).toHaveLength(FLEET_ROWS / 50);
    const sampleIds = sample.map((row) => row.id);
    openGatesFor(...sampleIds);
    await armPolicy({ partnerId: env.partner.id }, { level: 'partner', id: env.partner.id });
    const now = new Date();
    const refreshed = await refreshOemPolicySide({ now, scope: { deviceIds: sampleIds } });
    expect(refreshed.failedPages).toBe(0);
    const sampleRead: FleetRead = { where: inArray(devices.id, sampleIds), now, flagOn: true, fingerprint: oemGatesFingerprint() };
    const listed = await withSystemDbAccessContext(() => fleetPageQuery(sampleRead, sampleIds));
    const live = await liveStates(sampleIds, now);
    expect(listed).toHaveLength(sampleIds.length);
    const disagreements = listed.filter((row) => row.displayState !== live.get(row.deviceId));
    expect(disagreements.map((row) => ({ id: row.deviceId, sql: row.displayState, live: live.get(row.deviceId) }))).toEqual([]);
    expect(new Set(listed.map((row) => row.displayState)).size).toBeGreaterThanOrEqual(3);
  }, FLEET_TEST_TIMEOUT_MS);

  runDb('a stored row under other gates is pending: the request refreshes it before counting', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const device = await seedDevice(env.organization.id, env.site.id);
    openGatesFor(device.id);
    await armPolicy({ orgId: env.organization.id }, { level: 'organization', id: env.organization.id });
    // What a previous deploy, with the lane killed, would have stored.
    await getTestDb().insert(deviceOemPolicySide).values({
      deviceId: device.id,
      orgId: env.organization.id,
      offeredLane: 'dell',
      gatesFingerprint: 'f'.repeat(64),
      linkEnabled: false,
    });

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'partner')));

    expect(body.devices[0].displayState).toBe('overdue');
    expect(body.pendingRefresh).toBeUndefined();
    const [stored] = await getTestDb().select().from(deviceOemPolicySide).where(eq(deviceOemPolicySide.deviceId, device.id));
    expect(stored).toMatchObject({ gatesFingerprint: oemGatesFingerprint(), linkEnabled: true, offeredLane: 'dell' });
  });

  runDb('a stored row past its rollover is pending, not counted under the old occurrence', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const device = await seedDevice(env.organization.id, env.site.id);
    openGatesFor(device.id);
    // Armed today: the occurrence that just closed gave it no chance, so it is not overdue.
    await armPolicy({ orgId: env.organization.id }, { level: 'organization', id: env.organization.id }, { armedAt: new Date() });
    // A stale row that would read overdue if trusted: past its last night, rolled over.
    await getTestDb().insert(deviceOemPolicySide).values({
      deviceId: device.id,
      orgId: env.organization.id,
      offeredLane: 'dell',
      gatesFingerprint: oemGatesFingerprint(),
      linkEnabled: true,
      rebootMode: 'overnight',
      occurrenceKey: '2020-01',
      lastNightStart: new Date(Date.now() - 40 * DAY_MS),
      pastLastNightAt: new Date(Date.now() - 39 * DAY_MS),
      refreshAfter: new Date(Date.now() - DAY_MS),
      managedSince: LONG_AGO,
    });

    const { body } = await fleet(await createAccessToken(payloadFor(env, 'partner')));

    expect(body.devices[0].displayState).toBe('not_managed');
    const [stored] = await getTestDb().select().from(deviceOemPolicySide).where(eq(deviceOemPolicySide.deviceId, device.id));
    expect(stored!.refreshAfter!.getTime()).toBeGreaterThan(Date.now());
  });

  runDb('more pending devices than a request refreshes: answered as not managed, with pendingRefresh', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    const count = OEM_FLEET_PENDING_REFRESH_LIMIT + 1;
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, enrolled_at)
        SELECT ${env.organization.id}::uuid, ${env.site.id}::uuid, 'fleet-pending-' || n, 'pending-' || lpad(n::text, 4, '0'),
               'windows', '11', 'amd64', '0.127.0', 'online', ${LONG_AGO.toISOString()}::timestamp
        FROM generate_series(1, ${count}::int) AS n
      `);
    });

    const { status, body } = await fleet(await createAccessToken(payloadFor(env, 'partner')), '?limit=10');

    expect(status).toBe(200);
    expect(body.pendingRefresh).toBe(count);
    expect(body.total).toBe(count);
    expect(body.counts.not_managed).toBe(count);
    expect(body.devices).toHaveLength(10);
    const stored = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM device_oem_policy_side WHERE org_id = ${env.organization.id}::uuid`) as unknown as Array<{ n: number }>;
    expect(stored[0]!.n).toBe(0);
  });
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

  describe('#11247 run failing', () => {
    // Fixed clocks on the policy defaults: February's last night is the 24th, March's first the 17th.
    const FEBRUARY_NIGHT_ONE = new Date('2027-02-18T12:00:00.000Z');
    const PAST_FEBRUARY = new Date('2027-03-01T12:00:00.000Z');
    const MARCH_NIGHT_ONE = new Date('2027-03-18T12:00:00.000Z');
    const PAST_MARCH = new Date('2027-04-01T12:00:00.000Z');
    const RUN_FAILING = 'Vendor update: run failing';
    const SCHEDULE = {
      schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
      catchUpNights: 7,
    };

    async function failedRun(env: TestEnvironment, options: { trigger?: 'scheduled' | 'on_demand'; attempts?: number } = {}) {
      const { trigger = 'scheduled', attempts = 1 } = options;
      const device = await seedDevice(env.organization.id, env.site.id);
      openGatesFor(device.id);
      await armPolicy({ orgId: env.organization.id }, { level: 'organization', id: env.organization.id }, {
        settings: armedSettings(SCHEDULE),
      });
      const [command] = await getTestDb().insert(deviceCommands).values({
        deviceId: device.id,
        submittedOrgId: env.organization.id,
        type: CommandTypes.OEM_UPDATE_RUN,
        status: 'completed',
        payload: { lane: 'dell', trigger, occurrenceKey: trigger === 'scheduled' ? '2027-02' : null },
      }).returning({ id: deviceCommands.id });
      await getTestDb().insert(deviceOemUpdateStatus).values({
        deviceId: device.id,
        orgId: env.organization.id,
        applicability: 'applicable',
        lane: 'dell',
        lastOutcome: 'failed',
        occurrenceKey: '2027-02',
        attempts,
        lastCommandId: command!.id,
        lastSuccessAt: LONG_AGO,
      });
      return { device, commandId: command!.id };
    }

    const named = async (deviceId: string) => (await openAlerts(deviceId)).filter((alert) => alert.name === RUN_FAILING);

    runDb('reads the trigger from the real command: nothing on night 1, once past the last night, once after a tech closes it', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const { device, commandId } = await failedRun(env);

      await runOemOverdueSweep(FEBRUARY_NIGHT_ONE);
      expect(await openAlerts(device.id)).toEqual([]);

      await runOemOverdueSweep(PAST_FEBRUARY);
      const raised = await openAlerts(device.id);
      expect(raised.map((alert) => alert.name)).toEqual([RUN_FAILING]);
      expect(raised[0]!.status).toBe('active');
      expect(raised[0]!.context).toMatchObject({
        source: 'oem-updates',
        dedupeKey: '2027-02',
        occurrenceKey: '2027-02',
        lastOutcome: 'failed',
        commandId,
      });

      await withSystemDbAccessContext(() => db.update(alerts)
        .set({ status: 'resolved', resolvedAt: new Date() })
        .where(eq(alerts.id, raised[0]!.id)));
      // What holds it back is this read, not a cooldown: createAlert's lands after the commit,
      // on the outbox's own time, so a repeat sweep alone would pass with this read broken.
      expect(await priorOemAlerts(RUN_FAILING, [device.id])).toEqual([{ deviceId: device.id, dedupeKey: '2027-02', open: false }]);
      await runOemOverdueSweep(PAST_FEBRUARY);
      expect(await named(device.id)).toHaveLength(1);
    });

    runDb('a good run resolves it', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const { device } = await failedRun(env);
      await runOemOverdueSweep(PAST_FEBRUARY);
      expect((await named(device.id))[0]!.status).toBe('active');

      await getTestDb().update(deviceOemUpdateStatus)
        .set({ lastOutcome: 'success', lastSuccessAt: new Date(Date.now() + 60_000) })
        .where(eq(deviceOemUpdateStatus.deviceId, device.id));
      await runOemOverdueSweep(PAST_FEBRUARY);
      expect((await named(device.id))[0]!.status).toBe('resolved');
    });

    runDb('the next occurrence resolves it, and a failure in that occurrence raises its own', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const { device } = await failedRun(env);
      await runOemOverdueSweep(PAST_FEBRUARY);
      expect((await named(device.id))[0]!.status).toBe('active');

      await runOemOverdueSweep(MARCH_NIGHT_ONE);
      expect((await named(device.id)).map((alert) => alert.status)).toEqual(['resolved']);

      await getTestDb().update(deviceOemUpdateStatus)
        .set({ occurrenceKey: '2027-03' })
        .where(eq(deviceOemUpdateStatus.deviceId, device.id));
      // The sweep's clock moved a month and createAlert's cooldown runs on the real one. The
      // resolve set it, and it holds the alert back without spending it. Retried because the
      // raise's own cooldown lands on the outbox's time and can arrive after a clear.
      await runOemOverdueSweep(PAST_MARCH);
      expect(await named(device.id)).toHaveLength(1);
      await vi.waitFor(async () => {
        await clearDeviceCooldowns(device.id);
        await runOemOverdueSweep(PAST_MARCH);
        const both = await named(device.id);
        expect(both.map((alert) => (alert.context as { dedupeKey: string }).dedupeKey).sort()).toEqual(['2027-02', '2027-03']);
      }, { timeout: 20_000, interval: 250 });
    });

    runDb('a Run Now failure raises nothing', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const { device } = await failedRun(env, { trigger: 'on_demand' });
      await runOemOverdueSweep(PAST_FEBRUARY);
      expect(await openAlerts(device.id)).toEqual([]);
    });

    runDb('attempts used up raises the overdue rule and not this one', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const { device } = await failedRun(env, { attempts: 3 });
      await runOemOverdueSweep(PAST_FEBRUARY);
      expect((await openAlerts(device.id)).map((alert) => alert.name)).toEqual(['Vendor update: device overdue']);
    });
  });
});
