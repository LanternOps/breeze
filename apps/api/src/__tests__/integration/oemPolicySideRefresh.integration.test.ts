/**
 * The vendor update policy-side store against real Postgres and RLS (#11242): what a
 * refresh writes, what it leaves alone, which rows the due pass takes, that a
 * request-path refresh never widens past the ids it is given and resolves zones and
 * partner-wide links as the worker does, and how a policy write finds its owner.
 *
 * Gates are closed in code until the lab wave, so the lab override opens them for the
 * seeded devices. The arming gate is a write-path rule, so the settings go in directly.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceHardware,
  deviceOemPolicySide,
  devices,
  partners,
} from '../../db/schema';
import { resolveOemPolicySideRefreshScope } from '../../services/oemUpdates/policySideRefreshTrigger';
import { oemGatesFingerprint, refreshOemPolicySide } from '../../services/oemUpdates/policySideStore';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const LONG_AGO = new Date('2024-01-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function armedSettings(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
    catchUpNights: 7,
    reboot: 'overnight',
    vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
    ...overrides,
  };
}

async function seedDevice(orgId: string, siteId: string, overrides: Partial<typeof devices.$inferInsert> = {}) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `side-${randomUUID()}`,
    hostname: `side-${randomUUID().slice(0, 8)}`,
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

async function armPolicy(owner: { orgId: string } | { partnerId: string }, target: { level: 'organization' | 'partner'; id: string }, settings = armedSettings()) {
  const [policy] = await getTestDb().insert(configurationPolicies).values({
    name: `Vendor updates ${randomUUID().slice(0, 8)}`,
    status: 'active',
    ...('orgId' in owner ? { orgId: owner.orgId } : { partnerId: owner.partnerId }),
  } as typeof configurationPolicies.$inferInsert).returning();
  const [link] = await getTestDb().insert(configPolicyFeatureLinks).values({
    configPolicyId: policy!.id,
    featureType: 'oem_updates',
    inlineSettings: settings,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
  }).returning();
  await getTestDb().insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: target.level,
    targetId: target.id,
    createdAt: LONG_AGO,
  });
  return { policyId: policy!.id, linkId: link!.id };
}

function openGatesFor(...deviceIds: string[]) {
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', deviceIds.join(','));
}

const rowsFor = (deviceIds: string[]) => getTestDb()
  .select()
  .from(deviceOemPolicySide)
  .where(inArray(deviceOemPolicySide.deviceId, deviceIds));

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { partner, org, site };
}

describe('#11242 refreshOemPolicySide', () => {
  afterEach(() => vi.unstubAllEnvs());

  runDb('refresh upserts changed rows and skips unchanged ones', async () => {
    const { org, site } = await fixture();
    const a = await seedDevice(org.id, site.id);
    const b = await seedDevice(org.id, site.id);
    openGatesFor(a.id, b.id);
    const { linkId } = await armPolicy({ orgId: org.id }, { level: 'organization', id: org.id });
    const now = new Date();

    expect(await refreshOemPolicySide({ now, scope: { orgId: org.id } })).toMatchObject({ upserted: 2, failedPages: 0 });
    const first = await rowsFor([a.id, b.id]);
    expect(first).toHaveLength(2);
    for (const row of first) {
      expect(row).toMatchObject({ orgId: org.id, offeredLane: 'dell', linkId, linkEnabled: true, rebootMode: 'overnight', gatesFingerprint: oemGatesFingerprint() });
      expect(row.refreshAfter!.getTime()).toBeGreaterThan(now.getTime());
    }

    // Nothing changed: nothing written, `computed_at` left as it was.
    const later = new Date(now.getTime() + 60_000);
    expect(await refreshOemPolicySide({ now: later, scope: { orgId: org.id } })).toMatchObject({ upserted: 0 });
    expect((await rowsFor([a.id])).map((row) => row.computedAt.getTime())).toEqual([first.find((row) => row.deviceId === a.id)!.computedAt.getTime()]);

    // The link switched off: both rows change.
    await getTestDb().update(configPolicyFeatureLinks).set({ inlineSettings: armedSettings({ enabled: false }) }).where(eq(configPolicyFeatureLinks.id, linkId));
    expect(await refreshOemPolicySide({ now: later, scope: { orgId: org.id } })).toMatchObject({ upserted: 2 });
    for (const row of await rowsFor([a.id, b.id])) {
      expect(row).toMatchObject({ linkEnabled: false, occurrenceKey: null, refreshAfter: null, managedSince: null });
    }
  });

  runDb('dueOnly selects rows past refresh_after or with a stale gates fingerprint', async () => {
    const { org, site } = await fixture();
    const fresh = await seedDevice(org.id, site.id);
    const rolledOver = await seedDevice(org.id, site.id);
    const otherGates = await seedDevice(org.id, site.id);
    const missing = await seedDevice(org.id, site.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    const now = new Date();
    const fingerprint = oemGatesFingerprint();
    const stamped = new Date(now.getTime() - DAY_MS);
    await getTestDb().insert(deviceOemPolicySide).values([
      { deviceId: fresh.id, orgId: org.id, gatesFingerprint: fingerprint, refreshAfter: new Date(now.getTime() + DAY_MS), computedAt: stamped },
      { deviceId: rolledOver.id, orgId: org.id, gatesFingerprint: fingerprint, refreshAfter: new Date(now.getTime() - 1), computedAt: stamped },
      { deviceId: otherGates.id, orgId: org.id, gatesFingerprint: '0'.repeat(64), computedAt: stamped },
    ]);

    const result = await refreshOemPolicySide({ now, scope: { orgId: org.id }, dueOnly: true });

    expect(result).toMatchObject({ upserted: 3, failedPages: 0 });
    const byId = new Map((await rowsFor([fresh.id, rolledOver.id, otherGates.id, missing.id])).map((row) => [row.deviceId, row]));
    expect(byId.get(fresh.id)!.computedAt).toEqual(stamped);
    expect(byId.get(fresh.id)!.refreshAfter).not.toBeNull();
    for (const id of [rolledOver.id, otherGates.id, missing.id]) {
      // Dell hardware under the flag is offered its lane; no policy reaches it.
      expect(byId.get(id)).toMatchObject({ gatesFingerprint: fingerprint, offeredLane: 'dell', linkId: null, linkEnabled: false, refreshAfter: null });
      expect(byId.get(id)!.computedAt.getTime()).toBe(now.getTime());
    }
  });

  runDb('a deviceIds refresh never widens past the ids passed', async () => {
    const { org, site } = await fixture();
    const named = await seedDevice(org.id, site.id);
    const other = await seedDevice(org.id, site.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');

    expect(await refreshOemPolicySide({ now: new Date(), scope: { deviceIds: [named.id] } })).toMatchObject({ upserted: 1 });
    expect((await rowsFor([named.id, other.id])).map((row) => row.deviceId)).toEqual([named.id]);
    expect(await refreshOemPolicySide({ now: new Date(), scope: { deviceIds: [] } })).toMatchObject({ upserted: 0 });
  });

  runDb('from an org-scoped request context, a partner-wide link and the partner zone resolve as in system scope', async () => {
    const { partner, org, site } = await fixture();
    await getTestDb().update(partners).set({ timezone: 'Australia/Sydney' }).where(eq(partners.id, partner.id));
    const device = await seedDevice(org.id, site.id);
    openGatesFor(device.id);
    const { linkId } = await armPolicy({ partnerId: partner.id }, { level: 'partner', id: partner.id });
    const orgContext: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: null };
    const now = new Date();

    await withDbAccessContext(orgContext, () => refreshOemPolicySide({ now, scope: { deviceIds: [device.id] } }));

    const [row] = await rowsFor([device.id]);
    expect(row).toMatchObject({ linkId, linkEnabled: true });
    // The windows open at 01:00 Sydney time: 14:00 or 15:00 UTC the day before.
    expect([14, 15]).toContain(row!.lastNightStart!.getUTCHours());
  });

  runDb('with the flag off nothing is written', async () => {
    const { org, site } = await fixture();
    await seedDevice(org.id, site.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');

    expect(await refreshOemPolicySide({ now: new Date(), scope: { orgId: org.id } })).toEqual({ upserted: 0, pages: 0, failedPages: 0 });
    const stored = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM device_oem_policy_side WHERE org_id = ${org.id}::uuid`) as unknown as Array<{ n: number }>;
    expect(stored[0]!.n).toBe(0);
  });

  runDb('parked, Quick Support and decommissioned devices get no row', async () => {
    const { partner, org, site } = await fixture();
    const kept = await seedDevice(org.id, site.id);
    const ephemeral = await seedDevice(org.id, site.id, { isEphemeral: true });
    const decommissioned = await seedDevice(org.id, site.id, { status: 'decommissioned' });
    const pool = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const poolSite = await createSite({ orgId: pool.id });
    const parkedId = randomUUID();
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      await db.insert(devices).values({
        id: parkedId,
        orgId: pool.id,
        siteId: poolSite.id,
        agentId: `side-parked-${randomUUID()}`,
        hostname: 'side-parked',
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '0.127.0',
        status: 'online',
      });
    });
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');

    await refreshOemPolicySide({ now: new Date(), scope: { partnerId: partner.id } });

    expect((await rowsFor([kept.id, ephemeral.id, decommissioned.id, parkedId])).map((row) => row.deviceId)).toEqual([kept.id]);
  });
});

describe('#11242 refreshOemPolicySide paging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Many fleet devices in one org, through the owner connection with triggers off. */
  async function seedMany(orgId: string, siteId: string, count: number): Promise<void> {
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, enrolled_at)
        SELECT ${orgId}::uuid, ${siteId}::uuid, 'side-bulk-' || ${orgId} || '-' || n, 'side-bulk-' || lpad(n::text, 5, '0'),
               'windows', '11', 'amd64', '0.127.0', 'online', ${LONG_AGO.toISOString()}::timestamp
        FROM generate_series(1, ${count}::int) AS n
      `);
      await tx.execute(sql`
        INSERT INTO device_hardware (device_id, org_id, manufacturer, model)
        SELECT d.id, d.org_id, 'Dell Inc.', 'Latitude 7420' FROM devices d WHERE d.org_id = ${orgId}::uuid
      `);
    });
  }

  const storedCount = async (orgId: string) => (await getTestDb().execute(
    sql`SELECT count(*)::int AS n FROM device_oem_policy_side WHERE org_id = ${orgId}::uuid`,
  ) as unknown as Array<{ n: number }>)[0]!.n;

  /** Makes the `nth` statement whose text matches `pattern` fail, through any session. */
  function failNth(pattern: RegExp, nth: number) {
    const prepare = PostgresJsSession.prototype.prepareQuery;
    let seen = 0;
    vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (
      this: PostgresJsSession<never, never, never>,
      ...args: Parameters<typeof prepare>
    ) {
      if (pattern.test(args[0].sql)) {
        seen += 1;
        if (seen === nth) throw new Error('injected failure');
      }
      return prepare.apply(this, args);
    });
  }

  runDb('pages through more than 500 devices, and a full last page ends on an empty one', async () => {
    const { org, site } = await fixture();
    await seedMany(org.id, site.id, 1_000);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    const now = new Date();

    expect(await refreshOemPolicySide({ now, scope: { orgId: org.id } })).toEqual({ upserted: 1_000, pages: 3, failedPages: 0 });
    expect(await storedCount(org.id)).toBe(1_000);

    // One row lost: the due pass finds just that one.
    await getTestDb().execute(sql`
      DELETE FROM device_oem_policy_side
      WHERE device_id = (SELECT device_id FROM device_oem_policy_side WHERE org_id = ${org.id}::uuid ORDER BY device_id DESC LIMIT 1)
    `);
    expect(await refreshOemPolicySide({ now, scope: { orgId: org.id }, dueOnly: true })).toEqual({ upserted: 1, pages: 1, failedPages: 0 });
    expect(await storedCount(org.id)).toBe(1_000);
  });

  runDb('a page that fails to write is skipped, and the pages after it are still written', async () => {
    const { org, site } = await fixture();
    await seedMany(org.id, site.id, 1_001);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    failNth(/^insert into "device_oem_policy_side"/i, 2);

    const result = await refreshOemPolicySide({ now: new Date(), scope: { orgId: org.id } });

    expect(result).toEqual({ upserted: 501, pages: 3, failedPages: 1 });
    expect(await storedCount(org.id)).toBe(501);
  });

  runDb('a page that cannot be read ends the run', async () => {
    const { org, site } = await fixture();
    await seedMany(org.id, site.id, 10);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    failNth(/"device_hardware"[\s\S]*"device_oem_policy_side"/, 1);

    expect(await refreshOemPolicySide({ now: new Date(), scope: { orgId: org.id } })).toEqual({ upserted: 0, pages: 0, failedPages: 1 });
    expect(await storedCount(org.id)).toBe(0);
  });
});

describe('#11242 a policy write finds whose devices to refresh', () => {
  afterEach(() => vi.unstubAllEnvs());

  runDb('a policy with an oem_updates link resolves to its owner; one without, to nothing unless asked', async () => {
    const { partner, org } = await fixture();
    const partnerPolicy = await armPolicy({ partnerId: partner.id }, { level: 'partner', id: partner.id });
    const orgPolicy = await armPolicy({ orgId: org.id }, { level: 'organization', id: org.id });
    const [plain] = await getTestDb().insert(configurationPolicies).values({
      name: `Plain ${randomUUID().slice(0, 8)}`, status: 'active', orgId: org.id,
    } as typeof configurationPolicies.$inferInsert).returning();

    expect(await resolveOemPolicySideRefreshScope({ configPolicyId: partnerPolicy.policyId, onlyIfOemLinked: true })).toEqual({ partnerId: partner.id });
    expect(await resolveOemPolicySideRefreshScope({ configPolicyId: orgPolicy.policyId, onlyIfOemLinked: true })).toEqual({ orgId: org.id });
    expect(await resolveOemPolicySideRefreshScope({ configPolicyId: plain!.id, onlyIfOemLinked: true })).toBeNull();
    expect(await resolveOemPolicySideRefreshScope({ configPolicyId: plain!.id })).toEqual({ orgId: org.id });
    expect(await resolveOemPolicySideRefreshScope({ configPolicyId: randomUUID() })).toBeNull();
  });
});
