/**
 * Learned networks W01b (#12369, spec §8.1): applying a membership change, and the REST heartbeat wiring.
 * Writes go through the breeze_app pool under an org context, so RLS and the composite FKs are real.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import {
  applyNetworkAttachmentChange, planNetworkAttachmentIngest, type AttachmentDeviceState, type IngestPlan,
} from '../../services/learnedNetworks/ingest';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

const NOW = new Date('2026-11-20T15:05:00Z');
const MINUTE = 60_000;

const F1 = { gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c' } as const;
const F2 = { gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01' } as const;
const eth = (o: Record<string, unknown> = {}) => ({
  interfaceName: 'Ethernet', localAddress: '192.168.1.57', prefixLength: 24, ...F1, primary: true, ...o,
});
const wifi = (o: Record<string, unknown> = {}) => ({
  interfaceName: 'Wi-Fi', localAddress: '10.1.2.57', prefixLength: 24, ...F2, primary: false, ...o,
});

const admin = <T = Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const laptop = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'LAPTOP-JS' });
  const desktop = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'DESKTOP-01' });
  return { orgId: org.id, siteId: site.id, laptopId: laptop.id, desktopId: desktop.id };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function deviceState(orgId: string, deviceId: string): Promise<AttachmentDeviceState> {
  const [row] = await admin<{ is_ephemeral: boolean; epoch: string | null; sequence: string | null; digest: string | null }>(sql`
    SELECT is_ephemeral, network_attachment_epoch AS epoch, network_attachment_sequence AS sequence,
           network_attachment_digest AS digest
      FROM devices WHERE id = ${deviceId}::uuid`);
  return {
    id: deviceId, orgId, isEphemeral: row!.is_ephemeral, networkAttachmentEpoch: row!.epoch,
    networkAttachmentSequence: row!.sequence === null ? null : Number(row!.sequence), networkAttachmentDigest: row!.digest,
  };
}

const sequences = new Map<string, number>();
function nextSequence(deviceId: string): number {
  const n = (sequences.get(deviceId) ?? 0) + 1;
  sequences.set(deviceId, n);
  return n;
}

function reportFor(attachments: unknown[], o: { complete?: boolean; sequence: number; now: Date }) {
  return {
    epoch: '9f2c1e7ab4d04c11', sequence: o.sequence, capturedAt: o.now.toISOString(), complete: o.complete ?? true,
    attachments,
  };
}

type ApplyPlan = Extract<IngestPlan, { kind: 'apply' }>;

/** Plan as the heartbeat would, apply in the org context and a savepoint, then store the device fields. */
async function applyFor(
  t: Tenant, deviceId: string, attachments: unknown[],
  o: { wan?: string | null; complete?: boolean; now?: Date } = {},
): Promise<ApplyPlan> {
  const now = o.now ?? NOW;
  const raw = reportFor(attachments, { complete: o.complete, sequence: nextSequence(deviceId), now });
  const plan = planNetworkAttachmentIngest(await deviceState(t.orgId, deviceId), raw, o.wan ?? null, now);
  if (plan.kind !== 'apply') throw new Error(`expected an apply plan, got ${JSON.stringify(plan)}`);
  await withDbAccessContext(orgContext(t.orgId), () =>
    withDbTransaction(() => applyNetworkAttachmentChange({ id: deviceId, orgId: t.orgId }, plan, now)));
  await storeDeviceFields(deviceId, plan);
  return plan;
}

async function storeDeviceFields(deviceId: string, plan: ApplyPlan) {
  const f = plan.deviceFields;
  await admin(sql`UPDATE devices SET network_attachment_epoch = ${f.networkAttachmentEpoch},
    network_attachment_sequence = ${f.networkAttachmentSequence}, network_attachment_digest = ${f.networkAttachmentDigest},
    network_attachments_confirmed_at = ${f.networkAttachmentsConfirmedAt.toISOString()}::timestamptz
    WHERE id = ${deviceId}::uuid`);
}

async function counts(orgId: string) {
  const [row] = await admin<{ networks: number; gateways: number; members: number; wan: number }>(sql`
    SELECT (SELECT count(*)::int FROM learned_networks WHERE org_id = ${orgId}::uuid) AS networks,
           (SELECT count(*)::int FROM learned_network_gateways WHERE org_id = ${orgId}::uuid) AS gateways,
           (SELECT count(*)::int FROM learned_network_devices WHERE org_id = ${orgId}::uuid) AS members,
           (SELECT count(*)::int FROM learned_network_wan_addresses WHERE org_id = ${orgId}::uuid) AS wan`);
  return row!;
}

type MemberRow = {
  device_id: string; network_id: string; gateway_address: string; gateway_mac: string; interface_name: string;
  local_address: string; is_primary: boolean; is_current: boolean;
};
async function members(orgId: string): Promise<MemberRow[]> {
  return admin<MemberRow>(sql`
    SELECT m.device_id, g.network_id, host(g.gateway_address) AS gateway_address, g.gateway_mac::text AS gateway_mac,
           m.interface_name, host(m.local_address) AS local_address, m.is_primary, m.is_current
      FROM learned_network_devices m JOIN learned_network_gateways g ON g.id = m.gateway_id
     WHERE m.org_id = ${orgId}::uuid ORDER BY m.interface_name, g.gateway_address`);
}

async function seedNetwork(orgId: string, gateways: ReadonlyArray<{ gatewayAddress: string; gatewayMac: string }>) {
  const [n] = await admin<{ id: string }>(sql`
    INSERT INTO learned_networks (org_id, prefix) VALUES (${orgId}::uuid, '192.168.1.0/24') RETURNING id`);
  for (const g of gateways) {
    await admin(sql`INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
      VALUES (${orgId}::uuid, ${n!.id}::uuid, ${g.gatewayAddress}::inet, ${g.gatewayMac}::macaddr)`);
  }
  return n!.id;
}

describe('applyNetworkAttachmentChange', () => {
  it('a new fingerprint creates one unassigned network with its prefix, one gateway and a current membership', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth()]);
    const networks = await admin<{ site_id: string | null; prefix: string; ignored_at: string | null }>(sql`
      SELECT site_id, prefix::text AS prefix, ignored_at FROM learned_networks WHERE org_id = ${t.orgId}::uuid`);
    expect(networks).toEqual([{ site_id: null, prefix: '192.168.1.0/24', ignored_at: null }]);
    expect(await counts(t.orgId)).toEqual({ networks: 1, gateways: 1, members: 1, wan: 0 });
    expect(await members(t.orgId)).toEqual([expect.objectContaining({
      device_id: t.laptopId, gateway_address: '192.168.1.1', gateway_mac: 'a4:2b:b0:11:22:9c', interface_name: 'Ethernet',
      local_address: '192.168.1.57', is_primary: true, is_current: true,
    })]);
  });

  it('a known fingerprint reuses its network; a second device adds only a membership', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth()]);
    await applyFor(t, t.desktopId, [eth({ localAddress: '192.168.1.60' })]);
    expect(await counts(t.orgId)).toEqual({ networks: 1, gateways: 1, members: 2, wan: 0 });
    const rows = await members(t.orgId);
    expect(new Set(rows.map((r) => r.network_id)).size).toBe(1);
    expect(rows.map((r) => r.device_id).sort()).toEqual([t.laptopId, t.desktopId].sort());
  });

  it('T7 both memberships current', async () => {
    const t = await tenant();
    const networkId = await seedNetwork(t.orgId, [F1, F2]);
    await applyFor(t, t.laptopId, [eth(), wifi()]);
    const rows = await members(t.orgId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_current && r.network_id === networkId)).toBe(true);
    expect((await counts(t.orgId)).networks).toBe(1);
  });

  it('a complete report clears memberships it no longer lists; an incomplete one does not', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth(), wifi()]);
    await applyFor(t, t.laptopId, [eth()], { complete: false });
    expect((await members(t.orgId)).map((r) => [r.interface_name, r.is_current])).toEqual([['Ethernet', true], ['Wi-Fi', true]]);
    await applyFor(t, t.laptopId, [eth()], { complete: true });
    expect((await members(t.orgId)).map((r) => [r.interface_name, r.is_current])).toEqual([['Ethernet', true], ['Wi-Fi', false]]);
  });

  it('an empty complete list clears every current membership', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth(), wifi()]);
    await applyFor(t, t.laptopId, []);
    expect((await members(t.orgId)).map((r) => r.is_current)).toEqual([false, false]);
    expect((await counts(t.orgId)).networks).toBe(2);
  });

  it('null gateway MAC keeps the current membership', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth()]);
    const before = await counts(t.orgId);
    const later = new Date(NOW.getTime() + MINUTE);
    const plan = await applyFor(t, t.laptopId, [eth({ gatewayMac: null })], { now: later });
    expect(plan.kind).toBe('apply');
    expect(plan.deviceFields.networkAttachmentsConfirmedAt).toEqual(later);
    expect((await members(t.orgId)).map((r) => [r.interface_name, r.is_current])).toEqual([['Ethernet', true]]);
    expect(await counts(t.orgId)).toEqual(before);
  });

  it('a placeholder or multicast gateway MAC protects like a null MAC and creates nothing', async () => {
    for (const gatewayMac of ['02:00:00:00:00:00', '01:00:5e:00:00:01']) {
      const t = await tenant();
      await applyFor(t, t.laptopId, [eth()]);
      const before = await counts(t.orgId);
      await applyFor(t, t.laptopId, [eth({ gatewayMac })], { wan: '198.51.100.7' });
      expect((await members(t.orgId)).map((r) => [r.interface_name, r.is_current]), gatewayMac).toEqual([['Ethernet', true]]);
      expect(await counts(t.orgId), gatewayMac).toEqual(before);
    }
  });

  it('a null-MAC attachment on a different interface or address protects nothing', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth()]);
    await applyFor(t, t.laptopId, [eth({ gatewayMac: null, interfaceName: 'Ethernet 2' })]);
    expect((await members(t.orgId)).map((r) => r.is_current)).toEqual([false]);

    const u = await tenant();
    await applyFor(u, u.laptopId, [eth()]);
    await applyFor(u, u.laptopId, [eth({ gatewayMac: null, localAddress: '192.168.1.58' })]);
    expect((await members(u.orgId)).map((r) => r.is_current)).toEqual([false]);
  });

  it('two attachments behind one fingerprint make one row: the primary one wins', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [
      eth({ primary: false }),
      eth({ interfaceName: 'Wi-Fi', localAddress: '192.168.1.80', primary: true }),
    ]);
    expect(await members(t.orgId)).toEqual([expect.objectContaining({
      interface_name: 'Wi-Fi', local_address: '192.168.1.80', is_primary: true, is_current: true,
    })]);
  });

  it('two non-primary attachments behind one fingerprint keep the lowest interface name', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [
      eth({ interfaceName: 'Wi-Fi', localAddress: '192.168.1.80', primary: false }),
      eth({ primary: false }),
    ]);
    expect(await members(t.orgId)).toEqual([expect.objectContaining({ interface_name: 'Ethernet', local_address: '192.168.1.57' })]);
  });

  it('prefix is updated when the observed LAN prefix changes, and not written when equal', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth()]);
    const read = async () => (await admin<{ prefix: string; updated_at: string; xmin: string }>(sql`
      SELECT prefix::text AS prefix, updated_at::text AS updated_at, xmin::text AS xmin
        FROM learned_networks WHERE org_id = ${t.orgId}::uuid`))[0]!;
    const first = await read();
    await applyFor(t, t.laptopId, [eth({ localAddress: '192.168.1.58' })], { now: new Date(NOW.getTime() + MINUTE) });
    expect(await read()).toEqual(first);
    await applyFor(t, t.laptopId, [eth({ prefixLength: 25 })], { now: new Date(NOW.getTime() + 2 * MINUTE) });
    const changed = await read();
    expect(changed.prefix).toBe('192.168.1.0/25');
    expect(changed.updated_at).not.toBe(first.updated_at);
  });

  it('records the WAN address on the primary attachment network and caps it at 32', async () => {
    const t = await tenant();
    await applyFor(t, t.laptopId, [eth(), wifi()], { wan: '203.0.113.20' });
    const wanRows = () => admin<{ id: string; network_id: string; address: string; xmin: string }>(sql`
      SELECT id, network_id, host(address) AS address, xmin::text AS xmin
        FROM learned_network_wan_addresses WHERE org_id = ${t.orgId}::uuid ORDER BY last_seen_at, id`);
    const primaryNetwork = (await members(t.orgId)).find((r) => r.interface_name === 'Ethernet')!.network_id;
    const first = await wanRows();
    expect(first).toEqual([expect.objectContaining({ network_id: primaryNetwork, address: '203.0.113.20' })]);

    await applyFor(t, t.laptopId, [eth({ localAddress: '192.168.1.58' }), wifi()], { wan: '203.0.113.20' });
    expect(await wanRows()).toEqual(first);

    await admin(sql`UPDATE learned_network_wan_addresses SET last_seen_at = now() - interval '40 days'
      WHERE org_id = ${t.orgId}::uuid`);
    await admin(sql`INSERT INTO learned_network_wan_addresses (org_id, network_id, address, first_seen_at, last_seen_at)
      SELECT ${t.orgId}::uuid, ${primaryNetwork}::uuid, ('203.0.113.' || (100 + i))::inet,
             now() - make_interval(days => 39 - i), now() - make_interval(days => 39 - i)
        FROM generate_series(1, 31) AS i`);
    expect(await wanRows()).toHaveLength(32);
    await applyFor(t, t.laptopId, [eth({ localAddress: '192.168.1.59' }), wifi()], { wan: '198.51.100.7' });
    const after = await wanRows();
    expect(after).toHaveLength(32);
    expect(after.map((r) => r.address)).not.toContain('203.0.113.20');
    expect(after.map((r) => r.address)).toContain('198.51.100.7');
    expect(after.every((r) => r.network_id === primaryNetwork)).toBe(true);
  });

  it('does not create a network beyond the per-org limit', async () => {
    const t = await tenant();
    await admin(sql`INSERT INTO learned_networks (org_id) SELECT ${t.orgId}::uuid FROM generate_series(1, 5000)`);
    await applyFor(t, t.laptopId, [eth()]);
    expect(await counts(t.orgId)).toEqual({ networks: 5000, gateways: 0, members: 0, wan: 0 });
  });

  it('concurrent first sightings of one fingerprint create one network', async () => {
    const t = await tenant();
    const planFor = async (deviceId: string, localAddress: string) => {
      const raw = reportFor([eth({ localAddress })], { sequence: nextSequence(deviceId), now: NOW });
      const plan = planNetworkAttachmentIngest(await deviceState(t.orgId, deviceId), raw, null, NOW);
      if (plan.kind !== 'apply') throw new Error('expected apply');
      return plan;
    };
    const p1 = await planFor(t.laptopId, '192.168.1.57');
    const p2 = await planFor(t.desktopId, '192.168.1.60');

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let applied1!: () => void;
    const firstApplied = new Promise<void>((resolve) => { applied1 = resolve; });

    const tx1 = withSystemDbAccessContext(async () => {
      await applyNetworkAttachmentChange({ id: t.laptopId, orgId: t.orgId }, p1, NOW);
      applied1();
      await held;
    });
    await firstApplied;
    const tx2 = withSystemDbAccessContext(() => applyNetworkAttachmentChange({ id: t.desktopId, orgId: t.orgId }, p2, NOW));

    const deadline = Date.now() + 10_000;
    for (;;) {
      const [w] = await admin<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (w!.n >= 1) break;
      if (Date.now() > deadline) throw new Error('tx2 never waited on the fingerprint lock');
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await Promise.all([tx1, tx2]);

    expect(await counts(t.orgId)).toEqual({ networks: 1, gateways: 1, members: 2, wan: 0 });
    expect(new Set((await members(t.orgId)).map((r) => r.network_id)).size).toBe(1);
  });

  it('writes nothing to devices', async () => {
    const t = await tenant();
    const before = await admin<{ xmin: string }>(sql`SELECT xmin::text AS xmin FROM devices WHERE id = ${t.laptopId}::uuid`);
    const raw = reportFor([eth()], { sequence: nextSequence(t.laptopId), now: NOW });
    const plan = planNetworkAttachmentIngest(await deviceState(t.orgId, t.laptopId), raw, '203.0.113.20', NOW);
    if (plan.kind !== 'apply') throw new Error('expected apply');
    await withDbAccessContext(orgContext(t.orgId), () =>
      withDbTransaction(() => applyNetworkAttachmentChange({ id: t.laptopId, orgId: t.orgId }, plan, NOW)));
    expect(await admin(sql`SELECT xmin::text AS xmin FROM devices WHERE id = ${t.laptopId}::uuid`)).toEqual(before);
    expect((await counts(t.orgId)).members).toBe(1);
  });

  it('stays inside its org under RLS', async () => {
    const t = await tenant();
    const u = await tenant();
    await applyFor(t, t.laptopId, [eth()]);
    await applyFor(u, u.laptopId, [eth()]);
    expect(await counts(t.orgId)).toEqual({ networks: 1, gateways: 1, members: 1, wan: 0 });
    expect(await counts(u.orgId)).toEqual({ networks: 1, gateways: 1, members: 1, wan: 0 });
    const seen = await withDbAccessContext(orgContext(t.orgId), () =>
      db.execute(sql`SELECT count(*)::int AS n FROM learned_network_gateways`)) as unknown as Array<{ n: number }>;
    expect(seen[0]!.n).toBe(1);
  });
});
