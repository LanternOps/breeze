import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { getTestDb } from './setup';
import { createDevice, createOrganization, createSite, createUser, createPartner } from './db-utils';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

/**
 * Site location W2 Task 1 (#7886): the three presence read-model tables are RLS shape 1, the invalidation
 * triggers mark the org dirty, a device site/org change deletes its presence row (never restamps it across a
 * site FK), and org erasure removes every row. Spec S§7.1, S§7.4, S§15.
 */
const admin = <T extends Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id, name: 'Main Office' });
  const siteB = await createSite({ orgId: org.id, name: 'Lakeside' });
  const device = await createDevice({ orgId: org.id, siteId: siteA.id, hostname: 'DESKTOP-HD7K2QF' });
  return { partnerId: partner.id, orgId: org.id, siteA: siteA.id, siteB: siteB.id, deviceId: device.id };
}

type Tenant = Awaited<ReturnType<typeof tenant>>;

const insertState = (t: Pick<Tenant, 'orgId'>) => sql`
  INSERT INTO topology_org_presence_state (org_id, coverage) VALUES (${t.orgId}::uuid, 'complete')`;
const insertFingerprint = (t: Pick<Tenant, 'orgId' | 'siteB'>) => sql`
  INSERT INTO topology_site_fingerprints (org_id, site_id, prefix, gateway_address, status, fingerprint_version, evaluated_at, expires_at)
  VALUES (${t.orgId}::uuid, ${t.siteB}::uuid, '10.1.5.0/24', '10.1.5.1', 'anchored', 1, now(), now() + interval '1 hour')`;
const insertVisiting = (t: Pick<Tenant, 'orgId' | 'siteA' | 'siteB' | 'deviceId'>) => sql`
  INSERT INTO topology_device_presence (device_id, org_id, assigned_site_id, state, matched_site_id, prefix, gateway_address,
    fingerprint_version, evaluated_at, fresh_until)
  VALUES (${t.deviceId}::uuid, ${t.orgId}::uuid, ${t.siteA}::uuid, 'visiting', ${t.siteB}::uuid, '10.1.5.0/24', '10.1.5.1',
    1, now(), now() + interval '1 hour')`;

async function presenceRows(deviceId: string) {
  return admin<{ org_id: string }>(sql`SELECT org_id FROM topology_device_presence WHERE device_id = ${deviceId}::uuid`);
}
async function dirtyAt(orgId: string): Promise<string | null | undefined> {
  const [row] = await admin<{ dirty_at: string | Date | null }>(sql`SELECT dirty_at FROM topology_org_presence_state WHERE org_id = ${orgId}::uuid`);
  return row ? (row.dirty_at === null ? null : String(row.dirty_at)) : undefined;
}
async function clearDirty(orgId: string) {
  await admin(sql`UPDATE topology_org_presence_state SET dirty_at = NULL WHERE org_id = ${orgId}::uuid`);
}

describe('topology presence read model — tenancy', () => {
  it('forces RLS: a cross-org insert into each presence table fails with 42501, as breeze_app', async () => {
    const a = await tenant();
    const b = await tenant();
    for (const forged of [insertState(b), insertFingerprint(b), insertVisiting(b)]) {
      await expect(withDbAccessContext(orgContext(a.orgId), () => db.execute(forged))).rejects.toMatchObject({
        cause: { code: '42501', message: expect.stringMatching(/row-level security/i) },
      });
    }
  });

  it('same-org writes succeed as breeze_app and another org reads none of them', async () => {
    const a = await tenant();
    const b = await tenant();
    await withDbAccessContext(orgContext(a.orgId), async () => {
      await db.execute(insertState(a));
      await db.execute(insertFingerprint(a));
      await db.execute(insertVisiting(a));
    });
    const count = (orgId: string, table: string) => withDbAccessContext(orgContext(orgId), async () => {
      const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${a.orgId}::uuid`);
      return row!.n;
    });
    for (const table of ['topology_org_presence_state', 'topology_site_fingerprints', 'topology_device_presence']) {
      expect(await count(a.orgId, table), table).toBe(1);
      expect(await count(b.orgId, table), table).toBe(0);
    }
  });
});

describe('topology presence read model — invalidation triggers', () => {
  it('marks the org dirty when a discovery profile subnet changes, a baseline is added, or a site graph revision advances', async () => {
    const t = await tenant();
    expect(await dirtyAt(t.orgId)).toBeUndefined();

    // Under the request role, as the discovery routes write: the SECURITY DEFINER trigger must not 42501.
    const [profile] = await withDbAccessContext(orgContext(t.orgId), () => db.execute<{ id: string }>(sql`
      INSERT INTO discovery_profiles (org_id, site_id, name, enabled, subnets)
      VALUES (${t.orgId}::uuid, ${t.siteA}::uuid, 'Main LAN sweep', true, '{"10.1.2.0/24"}'::text[]) RETURNING id`));
    expect(await dirtyAt(t.orgId)).toEqual(expect.any(String));

    await clearDirty(t.orgId);
    await withDbAccessContext(orgContext(t.orgId), () => db.execute(sql`
      UPDATE discovery_profiles SET name = 'renamed' WHERE id = ${profile!.id}::uuid`));
    expect(await dirtyAt(t.orgId)).toBeNull(); // a name change declares nothing
    await withDbAccessContext(orgContext(t.orgId), () => db.execute(sql`
      UPDATE discovery_profiles SET subnets = '{"10.1.2.0/24","10.1.3.0/24"}'::text[] WHERE id = ${profile!.id}::uuid`));
    expect(await dirtyAt(t.orgId)).toEqual(expect.any(String));

    await clearDirty(t.orgId);
    await withDbAccessContext(orgContext(t.orgId), () => db.execute(sql`
      INSERT INTO network_baselines (org_id, site_id, subnet) VALUES (${t.orgId}::uuid, ${t.siteB}::uuid, '10.1.5.0/24')`));
    expect(await dirtyAt(t.orgId)).toEqual(expect.any(String));

    await clearDirty(t.orgId);
    await admin(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${t.orgId}::uuid, ${t.siteA}::uuid) ON CONFLICT DO NOTHING`);
    await admin(sql`UPDATE topology_site_state SET health_revision = health_revision + 1 WHERE site_id = ${t.siteA}::uuid`);
    expect(await dirtyAt(t.orgId)).toBeNull();
    // A publication alone never enrols an org: still not_configured (never evaluated) → not marked.
    await admin(sql`UPDATE topology_site_state SET graph_revision = graph_revision + 1 WHERE site_id = ${t.siteA}::uuid`);
    expect(await dirtyAt(t.orgId)).toBeNull();
    await admin(sql`UPDATE topology_org_presence_state SET coverage = 'complete' WHERE org_id = ${t.orgId}::uuid`);
    await admin(sql`UPDATE topology_site_state SET graph_revision = graph_revision + 1 WHERE site_id = ${t.siteA}::uuid`);
    expect(await dirtyAt(t.orgId)).toEqual(expect.any(String));
  });

  it('keeps the first dirty_at while the org is already dirty (debounce anchor)', async () => {
    const t = await tenant();
    await admin(insertState(t));
    await admin(sql`UPDATE topology_org_presence_state SET dirty_at = now() - interval '5 minutes' WHERE org_id = ${t.orgId}::uuid`);
    const before = await dirtyAt(t.orgId);
    await admin(sql`INSERT INTO network_baselines (org_id, site_id, subnet) VALUES (${t.orgId}::uuid, ${t.siteB}::uuid, '10.1.5.0/24')`);
    expect(await dirtyAt(t.orgId)).toEqual(before);
  });

  it('deletes the device presence row and marks dirty when devices.site_id changes (and only then)', async () => {
    const t = await tenant();
    await admin(insertState(t));
    await admin(insertVisiting(t));
    await clearDirty(t.orgId);

    await admin(sql`UPDATE devices SET hostname = 'renamed', site_id = site_id WHERE id = ${t.deviceId}::uuid`);
    expect(await presenceRows(t.deviceId)).toHaveLength(1);
    expect(await dirtyAt(t.orgId)).toBeNull();

    await withDbAccessContext(orgContext(t.orgId), () => db.execute(sql`
      UPDATE devices SET site_id = ${t.siteB}::uuid WHERE id = ${t.deviceId}::uuid`));
    expect(await presenceRows(t.deviceId)).toHaveLength(0);
    expect(await dirtyAt(t.orgId)).toEqual(expect.any(String));
    // Never an auto-move: the trigger only deletes presence; the site is what the caller wrote.
    const [device] = await admin<{ site_id: string }>(sql`SELECT site_id FROM devices WHERE id = ${t.deviceId}::uuid`);
    expect(device!.site_id).toBe(t.siteB);
  });

  it('cross-org device move deletes the visiting presence row (no restamp across the matched-site FK, no 23503)', async () => {
    const t = await tenant();
    const target = await createOrganization({ partnerId: t.partnerId });
    const targetSite = await createSite({ orgId: target.id });
    const actor = await createUser({ partnerId: t.partnerId });
    await admin(insertState(t));
    await admin(insertVisiting(t));
    await clearDirty(t.orgId);

    await withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: t.deviceId,
      sourceOrgId: t.orgId,
      targetOrgId: target.id,
      targetSiteId: targetSite.id,
      targetOrgName: 'target',
      deviceLinkGroupId: null,
      acceptCurrencyMismatch: false,
      actor: { userId: actor.id, allowedSiteIds: undefined },
      stepUp: null,
      via: 'generic_move',
    })));

    const [device] = await admin<{ org_id: string }>(sql`SELECT org_id FROM devices WHERE id = ${t.deviceId}::uuid`);
    expect(device!.org_id).toBe(target.id);
    expect(await presenceRows(t.deviceId)).toHaveLength(0);
    expect(await dirtyAt(t.orgId)).toEqual(expect.any(String));
    expect(await dirtyAt(target.id)).toEqual(expect.any(String));
  });

  it('a device leaving an org never creates a state row for the org it left', async () => {
    const t = await tenant();
    const target = await createOrganization({ partnerId: t.partnerId });
    const targetSite = await createSite({ orgId: target.id });
    await admin(sql`UPDATE devices SET org_id = ${target.id}::uuid, site_id = ${targetSite.id}::uuid WHERE id = ${t.deviceId}::uuid`);
    expect(await dirtyAt(t.orgId)).toBeUndefined();
    expect(await dirtyAt(target.id)).toEqual(expect.any(String));
  });

  it('org cascade delete removes all presence rows', async () => {
    const t = await tenant();
    const actor = await createUser({ partnerId: t.partnerId });
    await admin(insertState(t));
    await admin(insertFingerprint(t));
    await admin(insertVisiting(t));
    await cascadeDeleteOrg(t.orgId, actor.id);
    for (const table of ['topology_org_presence_state', 'topology_site_fingerprints', 'topology_device_presence']) {
      const [row] = await admin<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${t.orgId}::uuid`);
      expect(row!.n, table).toBe(0);
    }
  });
});
