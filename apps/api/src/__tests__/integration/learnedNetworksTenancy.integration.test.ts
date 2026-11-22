/**
 * Learned networks W01a (#12370, spec §6): schema, tenancy and the database-enforced invariants of the five
 * learned-network tables. Seeds go through the breeze_app pool under an org context; the role is asserted
 * non-bypass so every denial below is real RLS, a real composite-FK refusal or a real constraint trigger.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { partnerExportSiteMaterialState } from '../../db/schema';
import { isPgForeignKeyViolation, isPgUniqueViolation, pgErrorCode } from '../../utils/pgErrors';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

const TABLES = ['learned_networks', 'learned_network_gateways', 'learned_network_devices',
  'learned_network_wan_addresses', 'discovery_profile_snmp_grants'] as const;
type Table = typeof TABLES[number];

/** Index A2: every composite FK, its ON DELETE action (c cascade, n set null, a no action) and set-null columns. */
const A2_FKS = [
  { name: 'learned_networks_site_fk', action: 'n', setcols: ['site_id'] },
  { name: 'learned_network_gateways_network_fk', action: 'c', setcols: null },
  { name: 'learned_network_devices_device_fk', action: 'c', setcols: null },
  { name: 'learned_network_devices_gateway_fk', action: 'c', setcols: null },
  { name: 'learned_network_wan_addresses_network_fk', action: 'c', setcols: null },
  { name: 'discovery_profile_snmp_grants_profile_fk', action: 'c', setcols: null },
  { name: 'discovery_profile_snmp_grants_gateway_fk', action: 'c', setcols: null },
  { name: 'discovery_profiles_network_fk', action: 'a', setcols: null },
  { name: 'discovery_jobs_network_fk', action: 'n', setcols: ['network_id'] },
  { name: 'discovered_assets_last_network_fk', action: 'n', setcols: ['last_network_id'] },
] as const;

const admin = <T = Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;
const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);
const asOrg = <T = Record<string, unknown>>(orgId: string, query: SQL) =>
  scoped(orgId, () => db.execute(query)) as unknown as Promise<T[]>;

async function failure(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (err) { return err; }
  throw new Error('expected the statement to be refused, but it succeeded');
}
async function rejectsCode(work: Promise<unknown>, code: string) {
  expect(pgErrorCode(await failure(work))).toBe(code);
}

type Tenant = Awaited<ReturnType<typeof tenant>>;

/** One tenant: a network 192.168.1.0/24 via (192.168.1.1, a4:2b:b0:11:22:9c), one membership, one WAN row, a profile and a grant. */
async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'LAPTOP-JS' });
  const orgId = org.id;
  return scoped(orgId, async () => {
    const one = async (query: SQL) => ((await db.execute(query)) as unknown as Array<{ id: string }>)[0]!.id;
    const networkId = await one(sql`INSERT INTO learned_networks (org_id, prefix) VALUES (${orgId}::uuid, '192.168.1.0/24') RETURNING id`);
    const gatewayId = await one(sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
      VALUES (${orgId}::uuid, ${networkId}::uuid, '192.168.1.1', 'a4:2b:b0:11:22:9c') RETURNING id`);
    const memberId = await one(sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
      VALUES (${orgId}::uuid, ${device.id}::uuid, ${gatewayId}::uuid, 'Ethernet', '192.168.1.57') RETURNING id`);
    const wanId = await one(sql`INSERT INTO learned_network_wan_addresses (org_id, network_id, address)
      VALUES (${orgId}::uuid, ${networkId}::uuid, '203.0.113.20') RETURNING id`);
    const profileId = await one(sql`INSERT INTO discovery_profiles (org_id, site_id, name)
      VALUES (${orgId}::uuid, ${site.id}::uuid, 'Office scan') RETURNING id`);
    const grantId = await one(sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id)
      VALUES (${orgId}::uuid, ${profileId}::uuid, ${gatewayId}::uuid) RETURNING id`);
    return { partnerId: partner.id, orgId, siteId: site.id, deviceId: device.id, networkId, gatewayId, memberId, wanId, profileId, grantId };
  });
}

async function twoOrgs() {
  return { a: await tenant(), b: await tenant() };
}

const ownId = (t: Tenant, table: Table) => ({
  learned_networks: t.networkId,
  learned_network_gateways: t.gatewayId,
  learned_network_devices: t.memberId,
  learned_network_wan_addresses: t.wanId,
  discovery_profile_snmp_grants: t.grantId,
})[table];

/** A fresh, otherwise valid row for `table` stamped with `orgId`, pointing at `t`'s parents. */
function forgedInsert(table: Table, orgId: string, t: Tenant): SQL {
  switch (table) {
    case 'learned_networks':
      return sql`INSERT INTO learned_networks (org_id, prefix) VALUES (${orgId}::uuid, '10.1.2.0/24')`;
    case 'learned_network_gateways':
      return sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
        VALUES (${orgId}::uuid, ${t.networkId}::uuid, '10.1.2.100', '00:1a:8c:00:00:01')`;
    case 'learned_network_devices':
      return sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
        VALUES (${orgId}::uuid, ${t.deviceId}::uuid, ${t.gatewayId}::uuid, 'Wi-Fi', '10.1.2.57')`;
    case 'learned_network_wan_addresses':
      return sql`INSERT INTO learned_network_wan_addresses (org_id, network_id, address)
        VALUES (${orgId}::uuid, ${t.networkId}::uuid, '198.51.100.7')`;
    case 'discovery_profile_snmp_grants':
      return sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id)
        VALUES (${orgId}::uuid, ${t.profileId}::uuid, ${t.gatewayId}::uuid)`;
  }
}

/** Under org A's context, a write whose FK column names org B's parent row. */
async function crossOrgWrite(fk: typeof A2_FKS[number]['name'], a: Tenant, b: Tenant): Promise<void> {
  const writes: Record<typeof A2_FKS[number]['name'], SQL> = {
    learned_networks_site_fk: sql`INSERT INTO learned_networks (org_id, site_id) VALUES (${a.orgId}::uuid, ${b.siteId}::uuid)`,
    learned_network_gateways_network_fk: sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
      VALUES (${a.orgId}::uuid, ${b.networkId}::uuid, '10.1.2.100', '00:1a:8c:00:00:01')`,
    learned_network_devices_device_fk: sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
      VALUES (${a.orgId}::uuid, ${b.deviceId}::uuid, ${a.gatewayId}::uuid, 'Ethernet', '192.168.1.57')`,
    learned_network_devices_gateway_fk: sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
      VALUES (${a.orgId}::uuid, ${a.deviceId}::uuid, ${b.gatewayId}::uuid, 'Ethernet', '192.168.1.57')`,
    learned_network_wan_addresses_network_fk: sql`INSERT INTO learned_network_wan_addresses (org_id, network_id, address)
      VALUES (${a.orgId}::uuid, ${b.networkId}::uuid, '198.51.100.7')`,
    discovery_profile_snmp_grants_profile_fk: sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id)
      VALUES (${a.orgId}::uuid, ${b.profileId}::uuid, ${a.gatewayId}::uuid)`,
    discovery_profile_snmp_grants_gateway_fk: sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id)
      VALUES (${a.orgId}::uuid, ${a.profileId}::uuid, ${b.gatewayId}::uuid)`,
    discovery_profiles_network_fk: sql`UPDATE discovery_profiles SET network_id = ${b.networkId}::uuid WHERE id = ${a.profileId}::uuid`,
    discovery_jobs_network_fk: sql`INSERT INTO discovery_jobs (profile_id, org_id, site_id, network_id)
      VALUES (${a.profileId}::uuid, ${a.orgId}::uuid, ${a.siteId}::uuid, ${b.networkId}::uuid)`,
    discovered_assets_last_network_fk: sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, last_network_id)
      VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, '192.168.1.20', ${b.networkId}::uuid)`,
  };
  await asOrg(a.orgId, writes[fk]);
}

async function siteState(siteId: string) {
  const [state] = await getTestDb().select({ inventory: partnerExportSiteMaterialState.inventoryUpdatedAt })
    .from(partnerExportSiteMaterialState).where(eq(partnerExportSiteMaterialState.siteId, siteId));
  if (!state) throw new Error('site material state missing');
  return state;
}

describe('learned networks: RLS and composite tenancy FKs', () => {
  it('every table has RLS enabled and forced with the four org-isolation policies', async () => {
    const role = await db.execute(sql`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role[0]).toMatchObject({ current_user: 'breeze_app', rolsuper: false, rolbypassrls: false });
    for (const table of TABLES) {
      const [cls] = await admin(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ${`public.${table}`}::regclass`);
      expect(cls, table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await admin<{ policyname: string }>(sql`SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table} ORDER BY policyname`);
      expect(policies.map((p) => p.policyname), table).toEqual(['breeze_org_isolation_delete', 'breeze_org_isolation_insert',
        'breeze_org_isolation_select', 'breeze_org_isolation_update']);
    }
  });

  it.each(TABLES)('P6 %s: org B cannot read, change, delete or forge org A rows', async (table) => {
    const { a, b } = await twoOrgs();
    const id = ownId(a, table);
    const own = sql`id = ${id}::uuid`;
    const t = sql.identifier(table);
    expect(await asOrg(a.orgId, sql`SELECT id FROM ${t} WHERE ${own}`)).toHaveLength(1);
    expect(await asOrg(b.orgId, sql`SELECT id FROM ${t} WHERE ${own}`)).toHaveLength(0);
    expect(await asOrg(b.orgId, sql`UPDATE ${t} SET org_id = org_id WHERE ${own} RETURNING id`)).toHaveLength(0);
    expect(await asOrg(b.orgId, sql`DELETE FROM ${t} WHERE ${own} RETURNING id`)).toHaveLength(0);
    expect(await admin(sql`SELECT id FROM ${t} WHERE ${own}`)).toHaveLength(1);
    await rejectsCode(asOrg(b.orgId, forgedInsert(table, a.orgId, a)), '42501');
    await rejectsCode(asOrg(a.orgId, sql`UPDATE ${t} SET org_id = ${b.orgId}::uuid WHERE ${own}`), '42501');
  });

  it('every composite FK is deferrable, initially immediate, with the A2 action', async () => {
    const names = A2_FKS.map((f) => f.name);
    const rows = await admin<{ conname: string }>(sql`SELECT conname, condeferrable, condeferred, confdeltype,
      (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid = conrelid AND attnum = ANY (confdelsetcols)) AS setcols
      FROM pg_constraint WHERE contype = 'f' AND conname IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
    expect(rows).toHaveLength(10);
    for (const f of A2_FKS) {
      expect(rows.find((r) => r.conname === f.name), f.name)
        .toMatchObject({ condeferrable: true, condeferred: false, confdeltype: f.action, setcols: f.setcols });
    }
  });

  it.each(A2_FKS)('cross-org reference through $name is refused', async (fk) => {
    const { a, b } = await twoOrgs();
    const err = await failure(crossOrgWrite(fk.name, a, b));
    expect(isPgForeignKeyViolation(err, fk.name), String((err as Error)?.message)).toBe(true);
  });

  it('T7 two rows per device: one device behind two gateways of one network', async () => {
    const { a } = await twoOrgs();
    const [gw] = await asOrg<{ id: string }>(a.orgId, sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
      VALUES (${a.orgId}::uuid, ${a.networkId}::uuid, '10.1.2.100', '00:1a:8c:00:00:01') RETURNING id`);
    await asOrg(a.orgId, sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
      VALUES (${a.orgId}::uuid, ${a.deviceId}::uuid, ${gw!.id}::uuid, 'Wi-Fi', '10.1.2.57')`);
    const rows = await asOrg(a.orgId, sql`SELECT interface_name FROM learned_network_devices WHERE device_id = ${a.deviceId}::uuid ORDER BY interface_name`);
    expect(rows).toEqual([{ interface_name: 'Ethernet' }, { interface_name: 'Wi-Fi' }]);
    const dup = await failure(asOrg(a.orgId, sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
      VALUES (${a.orgId}::uuid, ${a.deviceId}::uuid, ${gw!.id}::uuid, 'Wi-Fi', '10.1.2.57')`));
    expect(isPgUniqueViolation(dup, 'learned_network_devices_device_gateway_uniq')).toBe(true);
  });

  it('deleting a network a profile points at is refused; a job or asset link is nulled', async () => {
    const { a } = await twoOrgs();
    await asOrg(a.orgId, sql`UPDATE discovery_profiles SET network_id = ${a.networkId}::uuid WHERE id = ${a.profileId}::uuid`);
    const blocked = await failure(asOrg(a.orgId, sql`DELETE FROM learned_networks WHERE id = ${a.networkId}::uuid`));
    expect(isPgForeignKeyViolation(blocked, 'discovery_profiles_network_fk')).toBe(true);

    await asOrg(a.orgId, sql`UPDATE discovery_profiles SET network_id = NULL WHERE id = ${a.profileId}::uuid`);
    const [job] = await asOrg<{ id: string }>(a.orgId, sql`INSERT INTO discovery_jobs (profile_id, org_id, site_id, network_id)
      VALUES (${a.profileId}::uuid, ${a.orgId}::uuid, ${a.siteId}::uuid, ${a.networkId}::uuid) RETURNING id`);
    const [asset] = await asOrg<{ id: string }>(a.orgId, sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, last_network_id)
      VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, '192.168.1.20', ${a.networkId}::uuid) RETURNING id`);
    expect(await asOrg(a.orgId, sql`DELETE FROM learned_networks WHERE id = ${a.networkId}::uuid RETURNING id`)).toHaveLength(1);
    expect(await admin(sql`SELECT network_id FROM discovery_jobs WHERE id = ${job!.id}::uuid`)).toEqual([{ network_id: null }]);
    expect(await admin(sql`SELECT last_network_id FROM discovered_assets WHERE id = ${asset!.id}::uuid`)).toEqual([{ last_network_id: null }]);
    // The network's children went with it.
    expect(await admin(sql`SELECT id FROM learned_network_gateways WHERE id = ${a.gatewayId}::uuid`)).toEqual([]);
    expect(await admin(sql`SELECT id FROM learned_network_devices WHERE id = ${a.memberId}::uuid`)).toEqual([]);
    expect(await admin(sql`SELECT id FROM discovery_profile_snmp_grants WHERE id = ${a.grantId}::uuid`)).toEqual([]);
    expect(await admin(sql`SELECT id FROM learned_network_wan_addresses WHERE id = ${a.wanId}::uuid`)).toEqual([]);
  });

  it('stamping discovered_assets.last_network_id is not partner-export material', async () => {
    const { a } = await twoOrgs();
    const [asset] = await admin<{ id: string }>(sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, asset_type, approval_status)
      VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, '192.168.1.1', 'router', 'approved') RETURNING id`);
    await admin(sql`SELECT public.breeze_partner_export_touch_sites(ARRAY[${a.siteId}::uuid], true, true)`);
    const before = await siteState(a.siteId);
    await admin(sql`UPDATE discovered_assets SET last_network_id = ${a.networkId}::uuid WHERE id = ${asset!.id}::uuid`);
    const afterStamp = await siteState(a.siteId);
    expect(afterStamp.inventory.getTime()).toBe(before.inventory.getTime());
    // Control: a material column still advances it, so the exclusion did not make the trigger inert.
    await admin(sql`UPDATE discovered_assets SET hostname = 'DESKTOP-01' WHERE id = ${asset!.id}::uuid`);
    expect((await siteState(a.siteId)).inventory.getTime()).toBeGreaterThan(afterStamp.inventory.getTime());
  });

  it('check constraints refuse an assigned and ignored network, IPv6 or non-host addresses, a bad grant mode and an oversized dispatch', async () => {
    const { a } = await twoOrgs();
    await rejectsCode(asOrg(a.orgId, sql`UPDATE learned_networks SET site_id = ${a.siteId}::uuid, ignored_at = now() WHERE id = ${a.networkId}::uuid`), '23514');
    await rejectsCode(asOrg(a.orgId, sql`INSERT INTO learned_networks (org_id, prefix) VALUES (${a.orgId}::uuid, '2001:db8::/64')`), '23514');
    for (const address of ['::1', '192.168.1.0/24']) {
      await rejectsCode(asOrg(a.orgId, sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
        VALUES (${a.orgId}::uuid, ${a.networkId}::uuid, ${address}::inet, '3c:37:86:aa:bb:10')`), '23514');
    }
    await rejectsCode(asOrg(a.orgId, sql`UPDATE learned_network_devices SET local_address = 'fe80::1' WHERE id = ${a.memberId}::uuid`), '23514');
    await rejectsCode(asOrg(a.orgId, sql`UPDATE discovery_profiles SET snmp_grant_mode = 'any' WHERE id = ${a.profileId}::uuid`), '23514');
    await asOrg(a.orgId, sql`UPDATE discovery_profiles SET snmp_grant_mode = 'bound' WHERE id = ${a.profileId}::uuid`);

    // {"k": "<n x>"} serialises to n + 9 bytes as jsonb text; size it from Postgres itself.
    const dispatchOf = (bytes: number) => JSON.stringify({ k: 'x'.repeat(bytes - 9) });
    const [size] = await admin<{ n: number }>(sql`SELECT octet_length((${dispatchOf(16384)})::jsonb::text) AS n`);
    expect(size).toEqual({ n: 16384 });
    const job = (dispatch: string) => asOrg(a.orgId, sql`INSERT INTO discovery_jobs (profile_id, org_id, site_id, network_dispatch)
      VALUES (${a.profileId}::uuid, ${a.orgId}::uuid, ${a.siteId}::uuid, ${dispatch}::jsonb)`);
    await rejectsCode(job(dispatchOf(16385)), '23514');
    await rejectsCode(job('[]'), '23514');
    await job(dispatchOf(16384));
  });
});
