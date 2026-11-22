/**
 * Learned networks W01b (#12369, spec §6 and §8.1): the hourly last-seen refresh and the daily retention.
 * Rows are seeded with explicit timestamps through the admin connection; the service runs as it does in the
 * worker, in system context on the breeze_app pool.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { refreshLearnedNetworkLastSeen, runLearnedNetworkRetention } from '../../services/learnedNetworks/maintenance';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const NOW = new Date('2026-11-20T15:05:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const admin = <T = Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;
const one = async (query: SQL) => (await admin<{ id: string }>(query))[0]!.id;

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const laptop = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'LAPTOP-JS' });
  const desktop = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'DESKTOP-01' });
  return { orgId: org.id, siteId: site.id, laptopId: laptop.id, desktopId: desktop.id };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function network(t: Tenant, lastSeen: string, o: { gatewayAddress?: string; gatewayMac?: string } = {}) {
  const networkId = await one(sql`INSERT INTO learned_networks (org_id, prefix, first_seen_at, last_seen_at)
    VALUES (${t.orgId}::uuid, '192.168.1.0/24', ${lastSeen}::timestamptz, ${lastSeen}::timestamptz) RETURNING id`);
  const gatewayId = await one(sql`INSERT INTO learned_network_gateways
      (org_id, network_id, gateway_address, gateway_mac, first_seen_at, last_seen_at)
    VALUES (${t.orgId}::uuid, ${networkId}::uuid, ${o.gatewayAddress ?? '192.168.1.1'}::inet,
            ${o.gatewayMac ?? 'a4:2b:b0:11:22:9c'}::macaddr, ${lastSeen}::timestamptz, ${lastSeen}::timestamptz)
    RETURNING id`);
  return { networkId, gatewayId };
}

async function member(t: Tenant, deviceId: string, gatewayId: string, lastSeen: string,
  o: { current?: boolean; primary?: boolean } = {}) {
  return one(sql`INSERT INTO learned_network_devices
      (org_id, device_id, gateway_id, interface_name, local_address, is_primary, is_current, first_seen_at, last_seen_at)
    VALUES (${t.orgId}::uuid, ${deviceId}::uuid, ${gatewayId}::uuid, 'Ethernet', '192.168.1.57',
            ${o.primary ?? true}, ${o.current ?? true}, ${lastSeen}::timestamptz, ${lastSeen}::timestamptz)
    RETURNING id`);
}

async function wan(t: Tenant, networkId: string, address: string, lastSeen: string) {
  return one(sql`INSERT INTO learned_network_wan_addresses (org_id, network_id, address, first_seen_at, last_seen_at)
    VALUES (${t.orgId}::uuid, ${networkId}::uuid, ${address}::inet, ${lastSeen}::timestamptz, ${lastSeen}::timestamptz)
    RETURNING id`);
}

async function confirmDevice(deviceId: string, confirmedAt: string, o: { lastSeenIp?: string; digest?: string } = {}) {
  await admin(sql`UPDATE devices SET network_attachments_confirmed_at = ${confirmedAt}::timestamptz,
    last_seen_ip = ${o.lastSeenIp ?? null}, network_attachment_digest = ${o.digest ?? 'd'.repeat(64)}
    WHERE id = ${deviceId}::uuid`);
}

const lastSeen = async (table: string, id: string) =>
  (await admin<{ t: string }>(sql`SELECT last_seen_at AS t FROM ${sql.raw(table)} WHERE id = ${id}::uuid`))[0]?.t;
const exists = async (table: string, id: string) =>
  (await admin(sql`SELECT 1 FROM ${sql.raw(table)} WHERE id = ${id}::uuid`)).length === 1;
const digestOf = async (deviceId: string) =>
  (await admin<{ d: string | null }>(sql`SELECT network_attachment_digest AS d FROM devices WHERE id = ${deviceId}::uuid`))[0]!.d;
const iso = (v: unknown) => new Date(v as string).toISOString();

describe('refreshLearnedNetworkLastSeen', () => {
  it("refresh copies a current row's device confirmation into the row, its gateway, network and WAN row", async () => {
    const t = await tenant();
    const { networkId, gatewayId } = await network(t, ago(3 * HOUR));
    const memberId = await member(t, t.laptopId, gatewayId, ago(3 * HOUR));
    const wanId = await wan(t, networkId, '203.0.113.20', ago(3 * HOUR));
    await confirmDevice(t.laptopId, ago(5 * MINUTE), { lastSeenIp: '203.0.113.20' });

    expect(await refreshLearnedNetworkLastSeen(NOW)).toEqual({ gateways: 1, networks: 1, devices: 1, wan: 1 });
    for (const [table, id] of [['learned_network_devices', memberId], ['learned_network_gateways', gatewayId],
      ['learned_networks', networkId], ['learned_network_wan_addresses', wanId]] as const) {
      expect(iso(await lastSeen(table, id)), table).toBe(ago(5 * MINUTE));
    }
    expect(await refreshLearnedNetworkLastSeen(NOW)).toEqual({ gateways: 0, networks: 0, devices: 0, wan: 0 });
  });

  it('refresh ignores rows that are not current and never moves a timestamp backwards', async () => {
    const t = await tenant();
    const a = await network(t, ago(3 * HOUR));
    const stale = await member(t, t.laptopId, a.gatewayId, ago(3 * HOUR), { current: false });
    await confirmDevice(t.laptopId, ago(5 * MINUTE));

    const b = await network(t, ago(1 * MINUTE), { gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01' });
    const fresh = await member(t, t.desktopId, b.gatewayId, ago(1 * MINUTE));
    await confirmDevice(t.desktopId, ago(5 * MINUTE));

    expect(await refreshLearnedNetworkLastSeen(NOW)).toEqual({ gateways: 0, networks: 0, devices: 0, wan: 0 });
    expect(iso(await lastSeen('learned_network_devices', stale))).toBe(ago(3 * HOUR));
    expect(iso(await lastSeen('learned_network_gateways', a.gatewayId))).toBe(ago(3 * HOUR));
    expect(iso(await lastSeen('learned_network_devices', fresh))).toBe(ago(1 * MINUTE));
  });

  it('a WAN row is dated only from a current primary row on its network whose device came from that address', async () => {
    const t = await tenant();
    const { networkId, gatewayId } = await network(t, ago(3 * HOUR));
    await member(t, t.laptopId, gatewayId, ago(3 * HOUR), { primary: false });
    const otherWan = await wan(t, networkId, '198.51.100.7', ago(3 * HOUR));
    await confirmDevice(t.laptopId, ago(5 * MINUTE), { lastSeenIp: '198.51.100.7' });
    expect((await refreshLearnedNetworkLastSeen(NOW)).wan).toBe(0);
    expect(iso(await lastSeen('learned_network_wan_addresses', otherWan))).toBe(ago(3 * HOUR));
  });

  it('a large backlog is refreshed across batches', async () => {
    const t = await tenant();
    const { gatewayId } = await network(t, ago(3 * HOUR));
    const ids = await admin<{ id: string }>(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
                           network_attachments_confirmed_at)
      SELECT ${t.orgId}::uuid, ${t.siteId}::uuid, 'agent-' || gen_random_uuid(), 'DESKTOP-01', 'windows', '11', 'amd64',
             '2.0.0', ${ago(5 * MINUTE)}::timestamptz
        FROM generate_series(1, 1203) RETURNING id`);
    await admin(sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address,
        first_seen_at, last_seen_at)
      SELECT ${t.orgId}::uuid, d.id, ${gatewayId}::uuid, 'Ethernet', '192.168.1.57', ${ago(3 * HOUR)}::timestamptz,
             ${ago(3 * HOUR)}::timestamptz
        FROM devices d WHERE d.org_id = ${t.orgId}::uuid AND d.network_attachments_confirmed_at IS NOT NULL`);
    expect(ids).toHaveLength(1203);
    expect(await refreshLearnedNetworkLastSeen(NOW)).toEqual({ gateways: 1, networks: 1, devices: 1203, wan: 0 });
  });
});

describe('runLearnedNetworkRetention', () => {
  it('retention deletes unassigned, unignored networks unseen for 90 days with their children', async () => {
    const t = await tenant();
    const n1 = await network(t, ago(91 * DAY));
    const m1 = await member(t, t.laptopId, n1.gatewayId, ago(10 * DAY));
    const w1 = await wan(t, n1.networkId, '203.0.113.20', ago(91 * DAY));
    await confirmDevice(t.laptopId, ago(10 * DAY));
    const n2 = await network(t, ago(89 * DAY), { gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01' });

    expect(await runLearnedNetworkRetention(NOW)).toEqual({ networksDeleted: 1, deviceRowsDeleted: 0 });
    expect(await exists('learned_networks', n1.networkId)).toBe(false);
    expect(await exists('learned_network_gateways', n1.gatewayId)).toBe(false);
    expect(await exists('learned_network_devices', m1)).toBe(false);
    expect(await exists('learned_network_wan_addresses', w1)).toBe(false);
    expect(await exists('learned_networks', n2.networkId)).toBe(true);
    // LAPTOP-JS lost a current row with the network: its next report is applied, not confirmed (A8).
    expect(await digestOf(t.laptopId)).toBeNull();
  });

  it('retention never deletes an assigned, ignored or profile-referenced network', async () => {
    const t = await tenant();
    await admin(sql`UPDATE sites SET discovery_network_required = true WHERE id = ${t.siteId}::uuid`);
    const assigned = await network(t, ago(400 * DAY));
    await admin(sql`UPDATE learned_networks SET site_id = ${t.siteId}::uuid WHERE id = ${assigned.networkId}::uuid`);
    const ignored = await network(t, ago(400 * DAY), { gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01' });
    await admin(sql`UPDATE learned_networks SET ignored_at = now() WHERE id = ${ignored.networkId}::uuid`);
    const referenced = await network(t, ago(400 * DAY), { gatewayMac: '3c:37:86:aa:bb:10' });
    await admin(sql`INSERT INTO discovery_profiles (org_id, site_id, name, network_id)
      VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, 'Office scan', ${referenced.networkId}::uuid)`);

    expect(await runLearnedNetworkRetention(NOW)).toEqual({ networksDeleted: 0, deviceRowsDeleted: 0 });
    for (const n of [assigned, ignored, referenced]) expect(await exists('learned_networks', n.networkId)).toBe(true);
  });

  it('retention deletes device rows unseen for 90 days and clears the device digest when the row was current', async () => {
    const t = await tenant();
    const { gatewayId } = await network(t, ago(1 * DAY));
    const g2 = (await network(t, ago(1 * DAY), { gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01' })).gatewayId;
    await confirmDevice(t.laptopId, ago(1 * DAY));
    await confirmDevice(t.desktopId, ago(1 * DAY));
    const a = await member(t, t.laptopId, gatewayId, ago(91 * DAY), { current: false });
    const b = await member(t, t.desktopId, gatewayId, ago(91 * DAY));
    const c = await member(t, t.desktopId, g2, ago(89 * DAY));

    expect(await runLearnedNetworkRetention(NOW)).toEqual({ networksDeleted: 0, deviceRowsDeleted: 2 });
    expect(await exists('learned_network_devices', a)).toBe(false);
    expect(await exists('learned_network_devices', b)).toBe(false);
    expect(await exists('learned_network_devices', c)).toBe(true);
    expect(await digestOf(t.laptopId)).toBe('d'.repeat(64));
    expect(await digestOf(t.desktopId)).toBeNull();
  });

  it('a job or asset pointing at a deleted network keeps its row with the link nulled', async () => {
    const t = await tenant();
    const n = await network(t, ago(91 * DAY));
    const profileId = await one(sql`INSERT INTO discovery_profiles (org_id, site_id, name)
      VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, 'Office scan') RETURNING id`);
    const jobId = await one(sql`INSERT INTO discovery_jobs (profile_id, org_id, site_id, network_id)
      VALUES (${profileId}::uuid, ${t.orgId}::uuid, ${t.siteId}::uuid, ${n.networkId}::uuid) RETURNING id`);
    const assetId = await one(sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, last_network_id)
      VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, '192.168.1.20', ${n.networkId}::uuid) RETURNING id`);

    expect(await runLearnedNetworkRetention(NOW)).toEqual({ networksDeleted: 1, deviceRowsDeleted: 0 });
    expect(await admin(sql`SELECT network_id FROM discovery_jobs WHERE id = ${jobId}::uuid`)).toEqual([{ network_id: null }]);
    expect(await admin(sql`SELECT last_network_id FROM discovered_assets WHERE id = ${assetId}::uuid`))
      .toEqual([{ last_network_id: null }]);
  });

  it('a large backlog of device rows is deleted across batches', async () => {
    const t = await tenant();
    const { gatewayId } = await network(t, ago(1 * DAY));
    await admin(sql`
      WITH d AS (
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
        SELECT ${t.orgId}::uuid, ${t.siteId}::uuid, 'agent-' || gen_random_uuid(), 'DESKTOP-01', 'windows', '11',
               'amd64', '2.0.0'
          FROM generate_series(1, 1203) RETURNING id)
      INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address, is_current,
                                           first_seen_at, last_seen_at)
      SELECT ${t.orgId}::uuid, d.id, ${gatewayId}::uuid, 'Ethernet', '192.168.1.57', false,
             ${ago(91 * DAY)}::timestamptz, ${ago(91 * DAY)}::timestamptz FROM d`);
    expect(await runLearnedNetworkRetention(NOW)).toEqual({ networksDeleted: 0, deviceRowsDeleted: 1203 });
  });
});
