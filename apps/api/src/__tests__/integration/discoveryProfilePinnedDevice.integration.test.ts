/**
 * #7969 — `discovery_profiles.pinned_device_id` is same-org at the DATABASE
 * level, and a deleted device unpins rather than blocks or deletes.
 *
 * Only real Postgres proves these:
 *
 *  1. Cross-org forge: the app role, in org A's RLS context, cannot point an
 *     org A profile at org B's device — `discovery_profiles_pinned_device_org_fk`
 *     ((pinned_device_id, org_id) -> devices(id, org_id)) refuses it with 23503,
 *     whatever the route layer did or forgot.
 *  2. Deleting the pinned device under org RLS nulls ONLY the pin (the
 *     column-list `ON DELETE SET NULL (pinned_device_id)`); the profile and its
 *     NOT NULL org_id survive.
 *  3. The constraint is DEFERRABLE INITIALLY IMMEDIATE (org merge defers it).
 *  4. A real device move-org clears the source-org pin before the org flip
 *     (otherwise the immediate FK check would abort the move with 23503).
 *  5. The selection module's SQL predicates (online, non-ephemeral, not
 *     parked, same org + site, agent-backed) hold against real rows — the
 *     unit tests mock the query builder and cannot see them.
 *
 * Fixtures are written with the superuser handle; the cases ABOUT the app role
 * use `db` under `withDbAccessContext`.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { loadSiteDiscoveryAgentCandidates, resolvePinnedDiscoveryAgent } from '../../jobs/discoveryAgentSelection';
import { deviceNetwork, devices, discoveryProfiles } from '../../db/schema';
import { Hono } from 'hono';
import { createDevice, createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

const admin = () => getTestDb() as any;

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

// setup.ts's cleanupDatabase() TRUNCATEs tenant tables before each test.

let fx: {
  orgA: string;
  orgB: string;
  siteA: string;
  deviceA: string;
  deviceB: string;
  profileId: string;
};

beforeEach(async () => {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const deviceA = await createDevice({ orgId: orgA.id, siteId: siteA.id });
  const deviceB = await createDevice({ orgId: orgB.id, siteId: siteB.id });
  const [profile] = await admin()
    .insert(discoveryProfiles)
    .values({ orgId: orgA.id, siteId: siteA.id, name: 'pin-fk', subnets: ['10.0.0.0/24'], methods: ['ping'] })
    .returning({ id: discoveryProfiles.id });
  fx = {
    orgA: orgA.id,
    orgB: orgB.id,
    siteA: siteA.id,
    deviceA: deviceA.id,
    deviceB: deviceB.id,
    profileId: profile.id,
  };
});


function pgCode(err: unknown): string | undefined {
  let cur: any = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

describe('discovery_profiles.pinned_device_id (#7969)', () => {
  it('the app role can pin a device in the profile\'s own org', async () => {
    const updated = await withDbAccessContext(orgCtx(fx.orgA), () =>
      db.update(discoveryProfiles)
        .set({ pinnedDeviceId: fx.deviceA })
        .where(eq(discoveryProfiles.id, fx.profileId))
        .returning({ id: discoveryProfiles.id }),
    );
    expect(updated).toHaveLength(1);
  });

  it('cross-org forge: the app role cannot pin another org\'s device (23503)', async () => {
    let caught: unknown;
    try {
      await withDbAccessContext(orgCtx(fx.orgA), () =>
        db.update(discoveryProfiles)
          .set({ pinnedDeviceId: fx.deviceB })
          .where(eq(discoveryProfiles.id, fx.profileId)),
      );
    } catch (err) {
      caught = err;
    }
    expect(pgCode(caught)).toBe('23503');

    const [row] = await admin()
      .select({ pinnedDeviceId: discoveryProfiles.pinnedDeviceId })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.id, fx.profileId));
    expect(row.pinnedDeviceId).toBeNull();
  });

  it('deleting the pinned device under org RLS unpins the profile and keeps it', async () => {
    await admin().update(discoveryProfiles).set({ pinnedDeviceId: fx.deviceA }).where(eq(discoveryProfiles.id, fx.profileId));

    const deleted = await withDbAccessContext(orgCtx(fx.orgA), () =>
      db.delete(devices).where(eq(devices.id, fx.deviceA)).returning({ id: devices.id }),
    );
    expect(deleted).toHaveLength(1);

    const [row] = await admin()
      .select({ pinnedDeviceId: discoveryProfiles.pinnedDeviceId, orgId: discoveryProfiles.orgId })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.id, fx.profileId));
    expect(row).toEqual({ pinnedDeviceId: null, orgId: fx.orgA });
  });

  it('is DEFERRABLE INITIALLY IMMEDIATE and nulls only the link column', async () => {
    const [row] = await admin().execute(sql`
      SELECT condeferrable, condeferred, confdeltype::text AS confdeltype,
             (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM unnest(c.confdelsetcols) AS k(attnum)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS set_null_cols
        FROM pg_constraint c
       WHERE c.conname = 'discovery_profiles_pinned_device_org_fk'
         AND c.conrelid = 'discovery_profiles'::regclass
    `);
    expect(row).toMatchObject({
      condeferrable: true,
      condeferred: false,
      confdeltype: 'n',
      set_null_cols: ['pinned_device_id'],
    });
  });
});

describe('device move-org with a pinned discovery profile (#7969)', () => {
  it('moves the device and clears the source-org pin before the FK can refuse the flip', async () => {
    const adminDb = admin();
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner, organization: orgA, site: siteA, user, role } = env;
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteB = await createSite({ orgId: orgB.id });
    const device = await createDevice({ orgId: orgA.id, siteId: siteA.id });
    const [profile] = await adminDb
      .insert(discoveryProfiles)
      .values({
        orgId: orgA.id, siteId: siteA.id, name: 'pinned-move', subnets: ['10.0.0.0/24'], methods: ['ping'],
        pinnedDeviceId: device.id,
      })
      .returning({ id: discoveryProfiles.id });

    const token = await createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: 'it-session',
    });
    const app = new Hono();
    app.route('/devices', moveOrgRoutes);

    const res = await app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(token, device.id, { orgId: orgB.id, siteId: siteB.id })),
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const [movedDevice] = await adminDb.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, device.id));
    expect(movedDevice.orgId).toBe(orgB.id);
    const [row] = await adminDb
      .select({ pinnedDeviceId: discoveryProfiles.pinnedDeviceId, orgId: discoveryProfiles.orgId })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.id, profile.id));
    // The profile stays in the source org and reverts to automatic selection.
    expect(row).toEqual({ pinnedDeviceId: null, orgId: orgA.id });
  });
});

describe('discovery agent selection predicates against real Postgres (#7969)', () => {
  async function setDevice(id: string, values: Record<string, unknown>) {
    await admin().update(devices).set(values).where(eq(devices.id, id));
  }

  it('site candidates exclude offline, ephemeral, other-site and other-org devices', async () => {
    const otherSite = await createSite({ orgId: fx.orgA });
    const valid = fx.deviceA;
    const offline = (await createDevice({ orgId: fx.orgA, siteId: fx.siteA })).id;
    const ephemeral = (await createDevice({ orgId: fx.orgA, siteId: fx.siteA })).id;
    const elsewhere = (await createDevice({ orgId: fx.orgA, siteId: otherSite.id })).id;
    for (const id of [valid, ephemeral, elsewhere, fx.deviceB]) await setDevice(id, { status: 'online' });
    await setDevice(offline, { status: 'offline' });
    await setDevice(ephemeral, { isEphemeral: true });
    await admin().insert(deviceNetwork).values({ deviceId: valid, orgId: fx.orgA, interfaceName: 'eth0', ipAddress: '10.0.0.7' });

    const candidates = await withSystemDbAccessContext(() => loadSiteDiscoveryAgentCandidates(fx.orgA, fx.siteA));

    expect(candidates.map((c) => c.deviceId)).toEqual([valid]);
    expect(candidates[0]!.addresses).toEqual(['10.0.0.7']);
  });

  it('a pinned device parked in a holding org never resolves, and holding-org site candidates are empty', async () => {
    const partner = await createPartner();
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const holdingSite = await createSite({ orgId: holding.id });
    // Only enrollment admission may create a device in a holding org.
    const parked = await admin().transaction(async (tx: any) => {
      await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      const [row] = await tx.execute(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
        VALUES (${holding.id}, ${holdingSite.id}, ${`agent-parked-${Date.now()}`}, 'parked-host', 'windows', '11', 'amd64', '2.0.0', 'online')
        RETURNING id`);
      return row.id as string;
    });

    const resolved = await withSystemDbAccessContext(() => resolvePinnedDiscoveryAgent(parked, holding.id, holdingSite.id));
    expect(resolved).toMatchObject({ ok: false, agentId: null });

    const candidates = await withSystemDbAccessContext(() => loadSiteDiscoveryAgentCandidates(holding.id, holdingSite.id));
    expect(candidates).toEqual([]);
  });

  it('an online pinned device in the profile site resolves to its agent; offline names it', async () => {
    await setDevice(fx.deviceA, { status: 'online' });
    const ok = await withSystemDbAccessContext(() => resolvePinnedDiscoveryAgent(fx.deviceA, fx.orgA, fx.siteA));
    expect(ok).toMatchObject({ ok: true });

    await setDevice(fx.deviceA, { status: 'offline' });
    const offline = await withSystemDbAccessContext(() => resolvePinnedDiscoveryAgent(fx.deviceA, fx.orgA, fx.siteA));
    expect(offline).toMatchObject({ ok: false, message: expect.stringMatching(/offline/) });
    expect(offline.ok ? null : offline.agentId).toEqual(expect.any(String));
  });
});
