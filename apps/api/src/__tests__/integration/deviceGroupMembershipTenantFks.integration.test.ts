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
 *   3. The detach — inside breeze_cascade_device_org_id(), an AFTER UPDATE OF
 *      org_id row trigger — really does beat the device FK's RI check, which
 *      is what INITIALLY DEFERRED buys. That ordering is decided by Postgres,
 *      and a mocked suite cannot see it at all. (A BEFORE trigger is not an
 *      option here: memberships carry
 *      breeze_touch_devices_after_membership_delete, which UPDATEs devices, so
 *      deleting them before the row update aborts with SQLSTATE 27000.)
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

describe('migration pre-flight repair (#3182)', () => {
  // The migration deletes rows that already violated the invariant before the
  // FKs existed — the accumulated residue of every past cross-org device move.
  // That statement can never run again on a database that has the constraints,
  // so this replays it the only way it can be replayed: both FKs are
  // DEFERRABLE, so a transaction can defer them, create the exact rows the
  // pre-flight is meant to find, run the migration's own DELETE verbatim, and
  // commit — a commit that would itself 23503 if the repair had missed one.
  //
  // The one property no other test can reach: a row violating BOTH axes must
  // be counted once, not twice. The migration reports the real ROW_COUNT of
  // the union rather than summing the two per-axis counts, and the assertion
  // below is what pins that.
  // The migration's DELETE, verbatim apart from the trailing device_id filter,
  // which keeps the reported ROW_COUNT deterministic when integration shards
  // share a database. The two EXISTS clauses — the part under test — are
  // unchanged, including the OR that makes a both-axes row one deletion.
  const repairSql = (deviceIds: string[]) => sql`
    DELETE FROM device_group_memberships m
     WHERE (
             EXISTS (
               SELECT 1 FROM device_groups g
                WHERE g.id = m.group_id AND g.org_id <> m.org_id
             )
             OR EXISTS (
               SELECT 1 FROM devices d
                WHERE d.id = m.device_id AND d.org_id <> m.org_id
             )
           )
       AND m.device_id IN (${sql.join(deviceIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `;

  it('deletes every violating row — group-axis, device-axis, and both at once — and leaves valid rows alone', async () => {
    const f = await seed();

    const counts = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      // The two forged rows below are stamped with DIFFERENT orgs, and each
      // INSERT's breeze_touch_devices_after_membership_insert acquires the
      // partner-export lock for its own row's org — so without this, the
      // second insert raises 'locks must be acquired in ascending UUID order'
      // whenever the random org uuids happen to land in the wrong sequence.
      // Take both up front, exactly as breeze_cascade_device_org_id() does for
      // the same reason (see the migration's header).
      await tx.execute(
        sql`SELECT breeze_partner_export_lock_orgs_exclusive(ARRAY[${f.sourceOrgId}::uuid, ${f.targetOrgId}::uuid])`,
      );

      // group-axis only: the device's org matches the row, the group's does not.
      await tx.execute(sql`
        INSERT INTO device_group_memberships (device_id, group_id, org_id)
        VALUES (${f.targetDeviceId}::uuid, ${f.sourceGroupId}::uuid, ${f.targetOrgId}::uuid)
      `);
      // BOTH axes: a second target-org group, a target-org device, stamped
      // with the SOURCE org — so neither parent is in the stamped org.
      // Counted once by the migration's union, twice by a naive sum.
      // (A distinct group is needed because (device_id, group_id) is the PK.)
      const [secondTargetGroup] = await tx.execute<{ id: string }>(sql`
        INSERT INTO device_groups (org_id, name, type)
        VALUES (${f.targetOrgId}::uuid, ${`dgm-preflight-${uid()}`}, 'static')
        RETURNING id
      `);
      await tx.execute(sql`
        INSERT INTO device_group_memberships (device_id, group_id, org_id)
        VALUES (${f.targetDeviceId}::uuid, ${secondTargetGroup!.id}::uuid, ${f.sourceOrgId}::uuid)
      `);

      // Scoped to this fixture's devices, not the whole table: integration
      // shards share one database, so a global count here would make the
      // assertions depend on what else is mid-flight.
      const scope = sql`m.device_id IN (${f.deviceId}::uuid, ${f.stayerId}::uuid, ${f.targetDeviceId}::uuid)`;
      const [groupAxis] = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM device_group_memberships m
          JOIN device_groups g ON g.id = m.group_id WHERE g.org_id <> m.org_id AND ${scope}
      `);
      const [deviceAxis] = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM device_group_memberships m
          JOIN devices d ON d.id = m.device_id WHERE d.org_id <> m.org_id AND ${scope}
      `);

      const deleted = await tx.execute(repairSql([f.deviceId, f.stayerId, f.targetDeviceId]));

      const [remaining] = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM device_group_memberships m WHERE ${scope}
      `);
      // Committing here is itself the assertion that the repair was complete:
      // the deferred FKs are checked now, and any missed row would 23503.
      return {
        groupAxis: Number(groupAxis!.n),
        deviceAxis: Number(deviceAxis!.n),
        deleted: deleted.count,
        remaining: Number(remaining!.n),
      };
    });

    expect(counts.groupAxis, 'both forged rows name a group in the wrong org').toBe(2);
    expect(counts.deviceAxis, 'only the second forged row ALSO names a device in the wrong org').toBe(1);
    expect(
      counts.deleted,
      'the union must delete 2 rows, not 3 — the row violating BOTH axes is one row, which is why the migration reports ROW_COUNT rather than groupAxis + deviceAxis',
    ).toBe(2);
    expect(counts.remaining, 'the three legitimate same-org memberships survive').toBe(3);

    // And the survivors are exactly the seeded, valid ones.
    expect(await readMemberships(f.deviceId)).toEqual([
      { groupId: f.sourceGroupId, orgId: f.sourceOrgId },
    ]);
    expect(await readMemberships(f.stayerId)).toEqual([
      { groupId: f.sourceGroupId, orgId: f.sourceOrgId },
    ]);
    expect(await readMemberships(f.targetDeviceId)).toEqual([
      { groupId: f.targetGroupId, orgId: f.targetOrgId },
    ]);
  });
});

describe('backupSlaWorker target resolution is org-scoped (#3182)', () => {
  // The composite FKs cannot reach this one: backup_sla_configs.target_groups
  // is a plain jsonb id array with no FK behind it, and POST/PATCH
  // /backup/sla writes it through without an ownership check. So a config in
  // org B naming org A's group id stays possible after the FKs land, and the
  // worker's own org predicate is the only thing that stops it — while the
  // worker runs under a system DB context with no RLS behind it.
  const seedConfig = async (
    orgId: string,
    targets: { targetGroups?: string[]; targetDevices?: string[] },
  ) => {
    const [row] = await (getTestDb() as never as AdminDb)
      .insert(backupSlaConfigs)
      .values({
        id: randomUUID(),
        orgId,
        name: `sla-${uid()}`,
        rpoTargetMinutes: 60,
        rtoTargetMinutes: 60,
        targetGroups: targets.targetGroups ?? [],
        targetDevices: targets.targetDevices ?? [],
        isActive: true,
      } as never)
      .returning();
    return row;
  };

  // Split from the direct-device case below on purpose: both vectors resolve
  // the same device id, so a combined fixture could not say WHICH clamp broke.
  it('a config naming ANOTHER org\'s GROUP id resolves no devices', async () => {
    const f = await seed();
    const { resolveTargetDeviceIds } = await import('../../jobs/backupSlaWorker');
    const foreign = await seedConfig(f.targetOrgId, { targetGroups: [f.sourceGroupId] });

    const resolved = await withSystemDbAccessContext(() =>
      resolveTargetDeviceIds(foreign as never),
    );

    expect(resolved, 'a foreign group\'s members may not be resolved for another org\'s SLA config').toEqual([]);
  });

  it('a config naming ANOTHER org\'s DEVICE id directly resolves no devices', async () => {
    const f = await seed();
    const { resolveTargetDeviceIds } = await import('../../jobs/backupSlaWorker');
    const foreign = await seedConfig(f.targetOrgId, { targetDevices: [f.deviceId] });

    const resolved = await withSystemDbAccessContext(() =>
      resolveTargetDeviceIds(foreign as never),
    );

    expect(
      resolved,
      'target_devices is written through by POST/PATCH /backup/sla with no ownership check, so the worker\'s own clamp is the only thing standing here',
    ).toEqual([]);
  });

  it('resolves its OWN org\'s group members and direct devices', async () => {
    const f = await seed();
    const { resolveTargetDeviceIds } = await import('../../jobs/backupSlaWorker');

    const own = await seedConfig(f.sourceOrgId, {
      targetGroups: [f.sourceGroupId],
      targetDevices: [f.stayerId],
    });

    const resolved = await withSystemDbAccessContext(() =>
      resolveTargetDeviceIds(own as never),
    );

    expect(resolved.sort()).toEqual([f.deviceId, f.stayerId].sort());
  });
});
