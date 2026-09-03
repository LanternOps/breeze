/**
 * Live-Postgres coverage for #3182: `device_group_memberships` must be pinned
 * to its parents' org, and a cross-org device move must detach it.
 *
 * WHY THIS NEEDS A REAL DATABASE
 * ------------------------------
 * Every claim below is a property of Postgres, not of TypeScript:
 *
 *   1. The two composite FKs (`(group_id, org_id) -> device_groups(id,
 *      org_id)`, `(device_id, org_id) -> devices(id, org_id)`) reject the
 *      forged shapes. `moveOrg.coverage.test.ts` can only assert the DDL text.
 *   2. The move no longer 23503s. `device_group_memberships` qualifies for
 *      `breeze_device_child_orgid_tables()`'s auto-discovery, so before this
 *      change the move RE-STAMPED the membership's org_id to the target org
 *      while its group_id kept naming the SOURCE org's group — producing the
 *      forged shape through ordinary supported use. With the FKs in place and
 *      no detach, that same re-stamp would abort the move outright.
 *   3. The detach really is a BEFORE trigger and really does beat the device
 *      FK's end-of-statement RI check. That ordering is decided by Postgres,
 *      and a mocked suite cannot see it at all.
 *   4. FORCE ROW LEVEL SECURITY on `device_group_memberships` does not
 *      silently make the detach a zero-row no-op for the unprivileged
 *      `breeze_app` role.
 *   5. The merge fence: an org merge moves devices AND their groups to the
 *      same survivor together, so the memberships must SURVIVE that flip.
 *
 * Three callers of `devices.org_id` are asserted, mirroring the #4645/#4792
 * siblings: the route, a raw `breeze_app` UPDATE under a system context (the
 * trigger alone), and the merge-fenced flip.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupSlaConfigs,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  organizations,
} from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type AdminDb = {
  insert: (typeof db)['insert'];
  select: (typeof db)['select'];
  execute: (typeof db)['execute'];
};

async function seed() {
  const adminDb = getTestDb() as never as AdminDb;
  const sfx = uid();

  const { partner, organization: sourceOrg, site: sourceSite, user, role } = await setupTestEnvironment({
    scope: 'partner',
  });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });

  const mkDevice = async (orgId: string, siteId: string, tag: string) => {
    const [row] = await adminDb
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `dgm-${tag}-${sfx}`,
        hostname: `dgm-${tag}-${sfx}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    return row!.id;
  };

  const deviceId = await mkDevice(sourceOrg.id, sourceSite.id, 'moving');
  // Negative control: never moves, so its membership must survive every case.
  const stayerId = await mkDevice(sourceOrg.id, sourceSite.id, 'stayer');
  const targetDeviceId = await mkDevice(targetOrg.id, targetSite.id, 'target');

  const mkGroup = async (orgId: string, tag: string) => {
    const [row] = await adminDb
      .insert(deviceGroups)
      .values({ orgId, name: `dgm-${tag}-${sfx}`, type: 'static' })
      .returning({ id: deviceGroups.id });
    return row!.id;
  };

  const sourceGroupId = await mkGroup(sourceOrg.id, 'source');
  const targetGroupId = await mkGroup(targetOrg.id, 'target');

  await adminDb.insert(deviceGroupMemberships).values([
    { deviceId, groupId: sourceGroupId, orgId: sourceOrg.id, addedBy: 'manual' },
    { deviceId: stayerId, groupId: sourceGroupId, orgId: sourceOrg.id, addedBy: 'manual' },
    { deviceId: targetDeviceId, groupId: targetGroupId, orgId: targetOrg.id, addedBy: 'manual' },
  ] as never);

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });

  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  const post = () =>
    app.request(`/devices/${deviceId}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: targetOrg.id, siteId: targetSite.id }),
    });

  return {
    partnerId: partner.id,
    deviceId,
    stayerId,
    targetDeviceId,
    sourceGroupId,
    targetGroupId,
    sourceOrgId: sourceOrg.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    post,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function readMemberships(deviceId: string) {
  return getTestDb()
    .select({ groupId: deviceGroupMemberships.groupId, orgId: deviceGroupMemberships.orgId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
}

async function readDeviceOrg(deviceId: string) {
  const [row] = await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId));
  return row?.orgId;
}

/** Every move path must leave exactly this state. */
async function assertMoveOutcome(f: Fixture) {
  expect(await readDeviceOrg(f.deviceId), 'the device moved').toBe(f.targetOrgId);
  expect(
    await readMemberships(f.deviceId),
    'the moved device must keep NO membership: it cannot belong to the source org\'s group, and there is no target-org group to re-point it to',
  ).toEqual([]);
  expect(
    await readMemberships(f.stayerId),
    'a device that did not move keeps its membership in the same group and org',
  ).toEqual([{ groupId: f.sourceGroupId, orgId: f.sourceOrgId }]);
  expect(
    await readMemberships(f.targetDeviceId),
    'an unrelated device in the TARGET org is untouched',
  ).toEqual([{ groupId: f.targetGroupId, orgId: f.targetOrgId }]);
}

describe('device_group_memberships composite tenant FKs (#3182)', () => {
  it('rejects a membership naming another org\'s GROUP, even stamped with the writer\'s own org', async () => {
    const f = await seed();

    // The exact row the issue reports: org B stamps its OWN org_id (so RLS is
    // satisfied — this is not an RLS failure) while naming org A's group.
    const err = await withSystemDbAccessContext(async () =>
      db.execute(sql`
        INSERT INTO device_group_memberships (device_id, group_id, org_id)
        VALUES (${f.targetDeviceId}::uuid, ${f.sourceGroupId}::uuid, ${f.targetOrgId}::uuid)
      `),
    ).then(() => null, (e: Error) => e);

    expect(err, 'the forged row must be rejected, not merely quarantined').toBeInstanceOf(Error);
    expect(JSON.stringify(err)).toContain('23503');
    expect(JSON.stringify(err)).toContain('device_group_memberships_group_org_fk');
  });

  it('rejects a membership naming another org\'s DEVICE', async () => {
    const f = await seed();

    // The mirror shape: the group's org is stamped, so the group FK is happy,
    // but the device belongs to the other org.
    const err = await withSystemDbAccessContext(async () =>
      db.execute(sql`
        INSERT INTO device_group_memberships (device_id, group_id, org_id)
        VALUES (${f.targetDeviceId}::uuid, ${f.sourceGroupId}::uuid, ${f.sourceOrgId}::uuid)
      `),
    ).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify(err)).toContain('23503');
    expect(JSON.stringify(err)).toContain('device_group_memberships_device_org_fk');
  });

  it('still accepts an ordinary same-org membership', async () => {
    const f = await seed();
    const secondGroupId = await (async () => {
      const [row] = await (getTestDb() as never as AdminDb)
        .insert(deviceGroups)
        .values({ orgId: f.sourceOrgId, name: `dgm-second-${uid()}`, type: 'static' })
        .returning({ id: deviceGroups.id });
      return row!.id;
    })();

    await withSystemDbAccessContext(async () =>
      db.execute(sql`
        INSERT INTO device_group_memberships (device_id, group_id, org_id)
        VALUES (${f.deviceId}::uuid, ${secondGroupId}::uuid, ${f.sourceOrgId}::uuid)
      `),
    );

    const rows = await readMemberships(f.deviceId);
    expect(rows.map((r) => r.groupId).sort()).toEqual([f.sourceGroupId, secondGroupId].sort());
  });
});

describe('cross-org device move detaches group memberships (#3182)', () => {
  it('POST /devices/:id/move-org succeeds and drops the moved device\'s memberships', async () => {
    const f = await seed();
    expect(await readMemberships(f.deviceId)).toHaveLength(1);

    const res = await f.post();
    const body = (await res.json()) as { success?: boolean; error?: string };
    // Without the detach this is a 500: the generic re-stamp loop would set
    // the membership's org_id to the target org while its group_id still
    // names the source org's group, violating the group FK.
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.success).toBe(true);

    await assertMoveOutcome(f);
  });

  it('a raw UPDATE devices as the unprivileged breeze_app role (system context) detaches them too', async () => {
    const f = await seed();

    // The trigger alone, with FORCE RLS in play — the route's own statement
    // never runs here.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
         WHERE id = ${f.deviceId}::uuid
      `);
    });

    await assertMoveOutcome(f);
  });

  it('a raw superuser UPDATE devices SET org_id detaches them as well', async () => {
    const f = await seed();

    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
       WHERE id = ${f.deviceId}::uuid
    `);

    await assertMoveOutcome(f);
  });

  it('SPARES the memberships while the source org is fenced for a merge', async () => {
    const f = await seed();

    // An org merge CASs the loser to status='merging' and then repoints
    // devices, device_groups and device_group_memberships to the survivor in
    // separate statements under SET CONSTRAINTS ALL DEFERRED
    // (services/orgMerge.ts, services/orgMergeRegistry.ts). The membership is
    // still valid throughout — both its parents are moving with it — so the
    // detach must not fire.
    await getTestDb()
      .update(organizations)
      .set({ status: 'merging' as never })
      .where(eq(organizations.id, f.sourceOrgId));

    // A real merge repoints EVERY device of the loser org, not one — so the
    // stayer moves too. Repointing only some would leave a device behind in
    // the source org while its membership claimed the survivor's, which the
    // device-axis FK correctly rejects.
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`
        UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
         WHERE org_id = ${f.sourceOrgId}::uuid
      `);
      await tx.execute(
        sql`UPDATE device_groups SET org_id = ${f.targetOrgId}::uuid WHERE org_id = ${f.sourceOrgId}::uuid`,
      );
      await tx.execute(sql`
        UPDATE device_group_memberships SET org_id = ${f.targetOrgId}::uuid
         WHERE org_id = ${f.sourceOrgId}::uuid
      `);
    });

    expect(
      await readMemberships(f.deviceId),
      'a merge moves the device AND its group to the survivor together — the membership must survive, re-stamped',
    ).toEqual([{ groupId: f.sourceGroupId, orgId: f.targetOrgId }]);
  });
});

describe('backupSlaWorker target resolution is org-scoped (#3182)', () => {
  // The composite FKs cannot reach this one: backup_sla_configs.target_groups
  // is a plain jsonb id array with no FK behind it, and POST/PATCH
  // /backup/sla writes it through without an ownership check. So a config in
  // org B naming org A's group id stays possible after the FKs land, and the
  // worker's own org predicate is the only thing that stops it — while the
  // worker runs under a system DB context with no RLS behind it.
  it('a config naming ANOTHER org\'s group id resolves no devices', async () => {
    const f = await seed();
    const { resolveTargetDeviceIds } = await import('../../jobs/backupSlaWorker');

    const [foreign] = await (getTestDb() as never as AdminDb)
      .insert(backupSlaConfigs)
      .values({
        id: randomUUID(),
        orgId: f.targetOrgId,
        name: `foreign-sla-${uid()}`,
        rpoTargetMinutes: 60,
        rtoTargetMinutes: 60,
        targetGroups: [f.sourceGroupId],
        targetDevices: [f.deviceId],
        isActive: true,
      } as never)
      .returning();

    const resolved = await withSystemDbAccessContext(() =>
      resolveTargetDeviceIds(foreign as never),
    );

    expect(
      resolved,
      'neither the foreign group\'s member nor the directly-named foreign device may be resolved for another org\'s SLA config',
    ).toEqual([]);
  });

  it('resolves its OWN org\'s group members and direct devices', async () => {
    const f = await seed();
    const { resolveTargetDeviceIds } = await import('../../jobs/backupSlaWorker');

    const [own] = await (getTestDb() as never as AdminDb)
      .insert(backupSlaConfigs)
      .values({
        id: randomUUID(),
        orgId: f.sourceOrgId,
        name: `own-sla-${uid()}`,
        rpoTargetMinutes: 60,
        rtoTargetMinutes: 60,
        targetGroups: [f.sourceGroupId],
        targetDevices: [f.stayerId],
        isActive: true,
      } as never)
      .returning();

    const resolved = await withSystemDbAccessContext(() =>
      resolveTargetDeviceIds(own as never),
    );

    expect(resolved.sort()).toEqual([f.deviceId, f.stayerId].sort());
  });
});
