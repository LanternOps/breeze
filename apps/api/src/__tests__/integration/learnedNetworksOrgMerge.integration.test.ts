/**
 * Learned networks W01a (#12370, spec §6, index A7): an org merge folds the loser's learned networks into the
 * survivor per fingerprint (gateway_mac, gateway_address). Device rows and grants move to the survivor's identical
 * fingerprint; a loser network whose fingerprints all fold into ONE survivor network is merged into it; any other
 * loser network that lost a fingerprint is kept, unassigned. Runs the real executeOrgMerge on real Postgres.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { executeOrgMerge, previewOrgMerge } from '../../services/orgMerge';
import { createDevice, createOrganization, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const admin = <T = Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;
const one = async (query: SQL) => (await admin<{ id: string }>(query))[0]!.id;

const F1 = { address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' };
const F2 = { address: '10.1.2.100', mac: '00:1a:8c:00:00:01' };
const F3 = { address: '192.168.1.1', mac: '3c:37:86:aa:bb:10' };
type Fingerprint = typeof F1;

let priorDrain: string | undefined;
beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

interface Pair { env: TestEnvironment; loser: string; loserSite: string; survivor: string; survivorSite: string }

async function pair(): Promise<Pair> {
  const env = await setupTestEnvironment();
  const survivor = await createOrganization({ partnerId: env.partner.id });
  const survivorSite = await createSite({ orgId: survivor.id });
  return { env, loser: env.organization.id, loserSite: env.site.id, survivor: survivor.id, survivorSite: survivorSite.id };
}

async function merge(p: Pair) {
  return executeOrgMerge({ loserOrgId: p.loser, survivorOrgId: p.survivor, partnerId: p.env.partner.id,
    performedBy: p.env.user.id, performedByEmail: p.env.user.email });
}

async function gate(siteId: string) {
  await admin(sql`UPDATE sites SET discovery_network_required = true WHERE id = ${siteId}::uuid`);
}

/** A network with the given fingerprints; returns its id and one gateway id per fingerprint. */
async function network(orgId: string, fingerprints: Fingerprint[], opts: { siteId?: string; userId?: string; name?: string } = {}) {
  const id = await one(sql`INSERT INTO learned_networks (org_id, site_id, name, assigned_by, assigned_at, prefix)
    VALUES (${orgId}::uuid, ${opts.siteId ?? null}::uuid, ${opts.name ?? null}, ${opts.siteId ? opts.userId ?? null : null}::uuid,
      ${opts.siteId ? sql`now()` : sql`NULL`}, '192.168.1.0/24') RETURNING id`);
  const gateways: string[] = [];
  for (const f of fingerprints) {
    gateways.push(await one(sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
      VALUES (${orgId}::uuid, ${id}::uuid, ${f.address}::inet, ${f.mac}::macaddr) RETURNING id`));
  }
  return { id, gateways };
}

async function member(orgId: string, deviceId: string, gatewayId: string, interfaceName = 'Ethernet', address = '192.168.1.57') {
  return one(sql`INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address)
    VALUES (${orgId}::uuid, ${deviceId}::uuid, ${gatewayId}::uuid, ${interfaceName}, ${address}::inet) RETURNING id`);
}

async function profile(orgId: string, siteId: string, networkId: string | null = null) {
  return one(sql`INSERT INTO discovery_profiles (org_id, site_id, name, network_id, snmp_grant_mode)
    VALUES (${orgId}::uuid, ${siteId}::uuid, 'Office scan', ${networkId}::uuid, 'bound') RETURNING id`);
}

async function wan(orgId: string, networkId: string, address: string, lastSeen: string, firstSeen = lastSeen) {
  await admin(sql`INSERT INTO learned_network_wan_addresses (org_id, network_id, address, first_seen_at, last_seen_at)
    VALUES (${orgId}::uuid, ${networkId}::uuid, ${address}::inet, ${firstSeen}::timestamptz, ${lastSeen}::timestamptz)`);
}

const networkRow = async (id: string) => (await admin<{ org_id: string; site_id: string | null; assigned_by: string | null;
  assigned_at: Date | null; ignored_at: Date | null; name: string | null }>(sql`SELECT org_id::text, site_id::text, assigned_by::text,
  assigned_at, ignored_at, name FROM learned_networks WHERE id = ${id}::uuid`))[0];
const gatewaysOf = async (networkId: string) => (await admin<{ id: string }>(sql`SELECT id::text FROM learned_network_gateways
  WHERE network_id = ${networkId}::uuid ORDER BY id`)).map((r) => r.id);
const fingerprintCount = (orgId: string, f: Fingerprint) => admin<{ n: number }>(sql`SELECT count(*)::int AS n FROM learned_network_gateways
  WHERE org_id = ${orgId}::uuid AND gateway_address = ${f.address}::inet AND gateway_mac = ${f.mac}::macaddr`);
const iso = (v: string | Date) => new Date(v).toISOString();
const gated = async (siteId: string) => (await admin<{ g: boolean }>(sql`SELECT discovery_network_required AS g FROM sites WHERE id = ${siteId}::uuid`))[0]!.g;

describe('learned networks org merge (A7)', () => {
  it('S8 grant re-points only to the identical fingerprint', async () => {
    const p = await pair();
    const nl = await network(p.loser, [F1]);
    const pl = await profile(p.loser, p.loserSite);
    await admin(sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id) VALUES (${p.loser}::uuid, ${pl}::uuid, ${nl.gateways[0]}::uuid)`);
    const ns = await network(p.survivor, [F1, F3]);
    await admin(sql`UPDATE learned_network_gateways SET first_seen_at = '2026-08-01T00:00:00Z' WHERE id = ${nl.gateways[0]}::uuid`);

    await merge(p);

    // The survivor fingerprint's seen window widens to the loser's earlier first sighting.
    const [widened] = await admin<{ first_seen_at: string }>(sql`SELECT first_seen_at FROM learned_network_gateways WHERE id = ${ns.gateways[0]}::uuid`);
    expect(iso(widened!.first_seen_at)).toBe('2026-08-01T00:00:00.000Z');
    const grants = await admin<{ gateway_id: string; org_id: string }>(sql`SELECT gateway_id::text, org_id::text
      FROM discovery_profile_snmp_grants WHERE profile_id = ${pl}::uuid`);
    expect(grants).toEqual([{ gateway_id: ns.gateways[0], org_id: p.survivor }]);
    expect(await fingerprintCount(p.survivor, F1)).toEqual([{ n: 1 }]);
    expect(await networkRow(nl.id)).toBeUndefined();
    expect(await admin(sql`SELECT network_id FROM discovery_profiles WHERE id = ${pl}::uuid`)).toEqual([{ network_id: null }]);
  });

  it('T6 split network is kept unassigned', async () => {
    const p = await pair();
    await gate(p.loserSite);
    const nl = await network(p.loser, [F1, F2], { siteId: p.loserSite, userId: p.env.user.id });
    const pl = await profile(p.loser, p.loserSite, nl.id);
    const desktop = await createDevice({ orgId: p.loser, siteId: p.loserSite, hostname: 'DESKTOP-01' });
    await member(p.loser, desktop.id, nl.gateways[0]!);
    await member(p.loser, desktop.id, nl.gateways[1]!, 'Wi-Fi', '10.1.2.57');
    const ns1 = await network(p.survivor, [F1]);
    const ns2 = await network(p.survivor, [F2]);

    await merge(p);

    expect(await networkRow(nl.id)).toMatchObject({ org_id: p.survivor, site_id: null, assigned_by: null, assigned_at: null });
    expect(await gatewaysOf(nl.id)).toEqual([]);
    expect(await admin(sql`SELECT network_id::text FROM discovery_profiles WHERE id = ${pl}::uuid`)).toEqual([{ network_id: nl.id }]);
    const rows = await admin<{ gateway_id: string; org_id: string }>(sql`SELECT gateway_id::text, org_id::text FROM learned_network_devices
      WHERE device_id = ${desktop.id}::uuid ORDER BY gateway_id`);
    expect(rows).toEqual([{ gateway_id: ns1.gateways[0]!, org_id: p.survivor }, { gateway_id: ns2.gateways[0]!, org_id: p.survivor }]
      .sort((a, b) => a.gateway_id.localeCompare(b.gateway_id)));
    expect(await gated(p.loserSite)).toBe(true);
  });

  it('a partial fold is kept unassigned like a split', async () => {
    const p = await pair();
    await gate(p.loserSite);
    const nl = await network(p.loser, [F1, F2], { siteId: p.loserSite, userId: p.env.user.id });
    const desktop = await createDevice({ orgId: p.loser, siteId: p.loserSite, hostname: 'DESKTOP-01' });
    await member(p.loser, desktop.id, nl.gateways[0]!);
    const pl = await profile(p.loser, p.loserSite, nl.id);
    for (const gw of nl.gateways) {
      await admin(sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id) VALUES (${p.loser}::uuid, ${pl}::uuid, ${gw}::uuid)`);
    }
    const ns = await network(p.survivor, [F1]);

    const result = await merge(p);

    expect(result.warnings.join('\n')).toContain('learned_networks: 0 merged into identical survivor networks, 1 left unassigned');
    expect(await networkRow(nl.id)).toMatchObject({ org_id: p.survivor, site_id: null, assigned_by: null, assigned_at: null });
    expect(await gatewaysOf(nl.id)).toEqual([nl.gateways[1]]);
    // The folded fingerprint's grant follows it to the survivor; the kept one stays on the kept gateway.
    const grants = await admin<{ gateway_id: string; org_id: string }>(sql`SELECT gateway_id::text, org_id::text
      FROM discovery_profile_snmp_grants WHERE profile_id = ${pl}::uuid ORDER BY gateway_id`);
    expect(grants).toEqual([{ gateway_id: ns.gateways[0]!, org_id: p.survivor }, { gateway_id: nl.gateways[1]!, org_id: p.survivor }]
      .sort((a, b) => a.gateway_id.localeCompare(b.gateway_id)));
    expect(await gatewaysOf(ns.id)).toEqual([ns.gateways[0]]);
    expect(await admin(sql`SELECT gateway_id::text FROM learned_network_devices WHERE device_id = ${desktop.id}::uuid`))
      .toEqual([{ gateway_id: ns.gateways[0] }]);
  });

  it('a whole fold merges the network and carries the assignment to an unassigned survivor network', async () => {
    const p = await pair();
    await gate(p.loserSite);
    const nl = await network(p.loser, [F1], { siteId: p.loserSite, userId: p.env.user.id, name: 'Front office' });
    await wan(p.loser, nl.id, '203.0.113.20', '2026-10-02T00:00:00Z', '2026-09-01T00:00:00Z');
    await wan(p.loser, nl.id, '198.51.100.7', '2026-10-03T00:00:00Z');
    const pl = await profile(p.loser, p.loserSite, nl.id);
    const job = await one(sql`INSERT INTO discovery_jobs (profile_id, org_id, site_id, network_id)
      VALUES (${pl}::uuid, ${p.loser}::uuid, ${p.loserSite}::uuid, ${nl.id}::uuid) RETURNING id`);
    const asset = await one(sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, last_network_id)
      VALUES (${p.loser}::uuid, ${p.loserSite}::uuid, '192.168.1.20', ${nl.id}::uuid) RETURNING id`);
    const ns = await network(p.survivor, [F1]);
    await wan(p.survivor, ns.id, '203.0.113.20', '2026-10-01T00:00:00Z', '2026-09-15T00:00:00Z');

    // The preview's drop count mirrors the fold: one folded gateway plus one merged network.
    const preview = await previewOrgMerge(p.loser, p.survivor, p.env.partner.id);
    expect(preview.tables.find((t) => t.table === 'learned_networks')).toMatchObject({ wouldDrop: 2 });
    const result = await merge(p);
    expect(result.summary.learned_networks).toMatchObject({ dropped: 2 });
    expect(result.warnings.join('\n')).toContain('learned_networks: 1 merged into identical survivor networks, 0 left unassigned');

    expect(await networkRow(nl.id)).toBeUndefined();
    expect(await admin(sql`SELECT network_id::text FROM discovery_profiles WHERE id = ${pl}::uuid`)).toEqual([{ network_id: ns.id }]);
    expect(await admin(sql`SELECT network_id::text FROM discovery_jobs WHERE id = ${job}::uuid`)).toEqual([{ network_id: ns.id }]);
    expect(await admin(sql`SELECT last_network_id::text FROM discovered_assets WHERE id = ${asset}::uuid`)).toEqual([{ last_network_id: ns.id }]);
    expect(await networkRow(ns.id)).toMatchObject({ org_id: p.survivor, site_id: p.loserSite, assigned_by: p.env.user.id, name: 'Front office' });
    expect(await admin(sql`SELECT org_id::text FROM sites WHERE id = ${p.loserSite}::uuid`)).toEqual([{ org_id: p.survivor }]);
    const wans = await admin<{ address: string; first_seen_at: Date; org_id: string }>(sql`SELECT host(address) AS address, first_seen_at, org_id::text
      FROM learned_network_wan_addresses WHERE network_id = ${ns.id}::uuid ORDER BY address`);
    expect(wans.map((w) => [w.address, w.org_id])).toEqual([['198.51.100.7', p.survivor], ['203.0.113.20', p.survivor]]);
    expect(new Date(wans[1]!.first_seen_at).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a whole fold keeps the survivor assignment when both are assigned', async () => {
    const p = await pair();
    await gate(p.loserSite);
    await gate(p.survivorSite);
    const nl = await network(p.loser, [F1], { siteId: p.loserSite, userId: p.env.user.id });
    const ns = await network(p.survivor, [F1], { siteId: p.survivorSite });

    await merge(p);

    expect(await networkRow(nl.id)).toBeUndefined();
    expect(await networkRow(ns.id)).toMatchObject({ site_id: p.survivorSite });
    expect(await admin(sql`SELECT id FROM learned_networks WHERE site_id = ${p.loserSite}::uuid`)).toEqual([]);
    expect(await gated(p.loserSite)).toBe(true);
  });

  it('a source site keeps discovery_network_required', async () => {
    const p = await pair();
    const bare = await createSite({ orgId: p.loser });
    await gate(p.loserSite);
    await gate(bare.id);
    const nl = await network(p.loser, [F2], { siteId: p.loserSite, userId: p.env.user.id });
    const laptop = await createDevice({ orgId: p.loser, siteId: p.loserSite, hostname: 'LAPTOP-JS' });
    const memberId = await member(p.loser, laptop.id, nl.gateways[0]!, 'Wi-Fi', '10.1.2.57');
    await wan(p.loser, nl.id, '203.0.113.20', '2026-10-01T00:00:00Z');
    const pl = await profile(p.loser, p.loserSite, nl.id);
    await admin(sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id) VALUES (${p.loser}::uuid, ${pl}::uuid, ${nl.gateways[0]}::uuid)`);

    const result = await merge(p);

    expect(await gated(p.loserSite)).toBe(true);
    expect(await gated(bare.id)).toBe(true);
    // No collision: everything moves as it is, assignment included, and no note is raised.
    expect(result.warnings.join('\n')).not.toContain('learned_networks:');
    expect(await networkRow(nl.id)).toMatchObject({ org_id: p.survivor, site_id: p.loserSite });
    for (const [table, id] of [['learned_network_gateways', nl.gateways[0]!], ['learned_network_devices', memberId]] as const) {
      expect(await admin(sql`SELECT org_id::text FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`), table).toEqual([{ org_id: p.survivor }]);
    }
    expect(await admin(sql`SELECT org_id::text FROM learned_network_wan_addresses WHERE network_id = ${nl.id}::uuid`)).toEqual([{ org_id: p.survivor }]);
    expect(await admin(sql`SELECT org_id::text FROM discovery_profile_snmp_grants WHERE profile_id = ${pl}::uuid`)).toEqual([{ org_id: p.survivor }]);
  });

  it('two source networks folding into one survivor network merge once, with shared WAN addresses aggregated', async () => {
    const p = await pair();
    const second = await createSite({ orgId: p.loser });
    await gate(p.loserSite);
    await gate(second.id);
    const n1 = await network(p.loser, [F1], { siteId: p.loserSite, userId: p.env.user.id });
    const n2 = await network(p.loser, [F2], { siteId: second.id, userId: p.env.user.id });
    await admin(sql`UPDATE learned_networks SET assigned_at = '2026-09-01T00:00:00Z' WHERE id = ${n2.id}::uuid`);
    await admin(sql`UPDATE learned_networks SET assigned_at = '2026-09-02T00:00:00Z' WHERE id = ${n1.id}::uuid`);
    await wan(p.loser, n1.id, '203.0.113.20', '2026-10-01T00:00:00Z', '2026-09-10T00:00:00Z');
    await wan(p.loser, n2.id, '203.0.113.20', '2026-10-05T00:00:00Z', '2026-09-20T00:00:00Z');
    await wan(p.loser, n2.id, '198.51.100.7', '2026-10-03T00:00:00Z');
    const p1 = await profile(p.loser, p.loserSite, n1.id);
    const p2 = await profile(p.loser, second.id, n2.id);
    const ns = await network(p.survivor, [F1, F2]);

    const preview = await previewOrgMerge(p.loser, p.survivor, p.env.partner.id);
    const result = await merge(p);

    // Two folded gateways plus two merged networks, and the preview predicted exactly that.
    expect(result.summary.learned_networks).toMatchObject({ dropped: 4 });
    expect(preview.tables.find((t) => t.table === 'learned_networks')).toMatchObject({ wouldDrop: 4 });
    expect(await networkRow(n1.id)).toBeUndefined();
    expect(await networkRow(n2.id)).toBeUndefined();
    // The earliest-assigned source network's assignment carries to the unassigned survivor network.
    expect(await networkRow(ns.id)).toMatchObject({ site_id: second.id });
    expect(await admin(sql`SELECT network_id::text FROM discovery_profiles WHERE id IN (${p1}::uuid, ${p2}::uuid)`))
      .toEqual([{ network_id: ns.id }, { network_id: ns.id }]);
    const wans = await admin<{ address: string; first_seen_at: string; last_seen_at: string }>(sql`SELECT host(address) AS address,
      first_seen_at, last_seen_at FROM learned_network_wan_addresses WHERE network_id = ${ns.id}::uuid ORDER BY address`);
    expect(wans.map((w) => [w.address, iso(w.first_seen_at), iso(w.last_seen_at)])).toEqual([
      ['198.51.100.7', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'],
      ['203.0.113.20', '2026-09-10T00:00:00.000Z', '2026-10-05T00:00:00.000Z'],
    ]);
    expect(await gated(p.loserSite)).toBe(true);
  });

  it('an ignored, unassigned survivor network takes the carried assignment and stops being ignored', async () => {
    const p = await pair();
    await gate(p.loserSite);
    await network(p.loser, [F1], { siteId: p.loserSite, userId: p.env.user.id });
    const ns = await network(p.survivor, [F1]);
    await admin(sql`UPDATE learned_networks SET ignored_at = now() WHERE id = ${ns.id}::uuid`);

    await merge(p);

    expect(await networkRow(ns.id)).toMatchObject({ site_id: p.loserSite, ignored_at: null });
  });

  it('device rows follow their fingerprint through the merge, and the device-move trigger leaves them alone', async () => {
    const p = await pair();
    const nl = await network(p.loser, [F1, F2]);
    const laptop = await createDevice({ orgId: p.loser, siteId: p.loserSite, hostname: 'LAPTOP-JS' });
    await member(p.loser, laptop.id, nl.gateways[0]!);
    await member(p.loser, laptop.id, nl.gateways[1]!, 'Wi-Fi', '10.1.2.57');
    await admin(sql`UPDATE devices SET network_attachment_epoch = 'e1', network_attachment_sequence = 42,
      network_attachment_digest = ${'d'.repeat(64)}, network_attachments_confirmed_at = '2026-10-01T00:00:00Z' WHERE id = ${laptop.id}::uuid`);
    const ns = await network(p.survivor, [F1]);

    await merge(p);

    const rows = await admin<{ gateway_id: string; org_id: string }>(sql`SELECT gateway_id::text, org_id::text FROM learned_network_devices
      WHERE device_id = ${laptop.id}::uuid ORDER BY interface_name`);
    expect(rows).toEqual([{ gateway_id: ns.gateways[0], org_id: p.survivor }, { gateway_id: nl.gateways[1], org_id: p.survivor }]);
    expect(await admin(sql`SELECT org_id::text, network_id::text FROM learned_network_gateways WHERE id = ${nl.gateways[1]}::uuid`))
      .toEqual([{ org_id: p.survivor, network_id: nl.id }]);
    expect(await admin(sql`SELECT network_attachment_epoch, network_attachment_sequence::text AS seq, network_attachment_digest
      FROM devices WHERE id = ${laptop.id}::uuid`)).toEqual([{ network_attachment_epoch: 'e1', seq: '42', network_attachment_digest: 'd'.repeat(64) }]);
  });

  it('trims a folded network to 32 WAN addresses, oldest last_seen_at dropped', async () => {
    const p = await pair();
    const nl = await network(p.loser, [F1]);
    const ns = await network(p.survivor, [F1]);
    // 40 distinct documentation-range addresses, alternating owner, each a day apart (day 1 oldest).
    for (let i = 1; i <= 40; i++) {
      const address = i % 2 === 0 ? `203.0.113.${100 + i}` : `198.51.100.${100 + i}`;
      const day = `2026-09-${String(((i - 1) % 30) + 1).padStart(2, '0')}T${String(Math.floor((i - 1) / 30)).padStart(2, '0')}:00:00Z`;
      await wan(i % 2 === 0 ? p.survivor : p.loser, i % 2 === 0 ? ns.id : nl.id, address, day);
    }
    const ranked = await admin<{ address: string }>(sql`SELECT host(address) AS address FROM learned_network_wan_addresses
      WHERE network_id IN (${nl.id}::uuid, ${ns.id}::uuid) ORDER BY last_seen_at ASC`);
    const oldestEight = ranked.slice(0, 8).map((r) => r.address).sort();

    await merge(p);

    const kept = (await admin<{ address: string }>(sql`SELECT host(address) AS address FROM learned_network_wan_addresses
      WHERE network_id = ${ns.id}::uuid`)).map((r) => r.address);
    expect(kept).toHaveLength(32);
    for (const gone of oldestEight) expect(kept).not.toContain(gone);
  });
});
