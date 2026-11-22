/**
 * Learned networks W01b (#12369, spec §8.1): applying a membership change, and the REST heartbeat wiring.
 * Writes go through the breeze_app pool under an org context, so RLS and the composite FKs are real.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql, type SQL } from 'drizzle-orm';

const clientIp = vi.hoisted(() => ({ value: '203.0.113.20' as string | undefined }));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  getTrustedClientIpOrUndefined: () => clientIp.value,
}));

import { db, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { auditLogs, enrollmentKeys } from '../../db/schema';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';
import { metricsRegistry } from '../../services/metricsRegistry';
import {
  applyNetworkAttachmentChange, planNetworkAttachmentIngest, type AttachmentDeviceState, type IngestPlan,
} from '../../services/learnedNetworks/ingest';
import { clearStatementFaults, failWritesOn } from './caughtQueryFaults';
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

// ---------------------------------------------------------------------------------------------------------------
// The REST heartbeat route (fixture copied from heartbeatRetainState.integration.test.ts).

async function seedOrg(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `learned-${suffix}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: org.id, siteId: site.id, name: `Learned ${label}`, key: hashEnrollmentKey(rawKey),
      keySecretHash: null, usageCount: 0, maxUsage: null, expiresAt: null,
    });
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, rawKey, suffix };
}
type SeededOrg = Awaited<ReturnType<typeof seedOrg>>;

async function waitForEnrollAuditCommitted(deviceId: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const found = await withSystemDbAccessContext(() =>
      db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, 'agent.enroll'), eq(auditLogs.resourceId, deviceId))).limit(1));
    if (found.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`agent.enroll audit row for device ${deviceId} never became visible (10s)`);
}

async function enrollDevice(org: SeededOrg, hostname: string) {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  const response = await app.request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentKey: org.rawKey, hostname: `${hostname}-${org.suffix}`, osType: 'windows',
      osVersion: 'Integration Windows', architecture: 'amd64', agentVersion: '1.0.0-test',
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { deviceId: string; agentId: string };
  await waitForEnrollAuditCommitted(body.deviceId);
  return { deviceId: body.deviceId, agentId: body.agentId, orgId: org.orgId, siteId: org.siteId, partnerId: org.partnerId };
}
type EnrolledDevice = Awaited<ReturnType<typeof enrollDevice>>;

function agentApp(device: EnrolledDevice, o: { role?: 'agent' | 'watchdog'; isPreAssignment?: boolean } = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: device.deviceId, agentId: device.agentId, orgId: device.orgId, siteId: device.siteId,
      partnerId: device.partnerId, role: o.role ?? 'agent', isPreAssignment: o.isPreAssignment ?? false,
    } as never);
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

const ROUTE_EPOCH = '9f2c1e7ab4d04c11';
/** A report captured now (the route plans against the real clock). */
function liveReport(sequence: number, o: { attachments?: unknown[]; capturedAt?: Date; complete?: boolean } = {}) {
  return {
    epoch: ROUTE_EPOCH, sequence, capturedAt: (o.capturedAt ?? new Date()).toISOString(), complete: o.complete ?? true,
    attachments: o.attachments ?? [eth()],
  };
}

async function beat(
  device: EnrolledDevice, networkAttachmentsV1: unknown,
  o: { role?: 'agent' | 'watchdog'; isPreAssignment?: boolean; expectStatus?: number | null } = {},
): Promise<number> {
  const body: Record<string, unknown> = { status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false };
  if (networkAttachmentsV1 !== undefined) body.networkAttachmentsV1 = networkAttachmentsV1;
  if (o.role === 'watchdog') body.role = 'watchdog';
  const response = await agentApp(device, o).request(`/agents/${device.agentId}/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await response.text();
  if (o.expectStatus !== null) expect(response.status).toBe(o.expectStatus ?? 200);
  return response.status;
}

type DeviceColumns = {
  epoch: string | null; sequence: string | null; digest: string | null; confirmed_at: string | null;
  last_seen_at: string | null; partner_export_updated_at: string;
};
async function deviceColumns(deviceId: string): Promise<DeviceColumns> {
  const [row] = await admin<DeviceColumns>(sql`
    SELECT network_attachment_epoch AS epoch, network_attachment_sequence::text AS sequence,
           network_attachment_digest AS digest, network_attachments_confirmed_at::text AS confirmed_at,
           last_seen_at::text AS last_seen_at, partner_export_updated_at::text AS partner_export_updated_at
      FROM devices WHERE id = ${deviceId}::uuid`);
  return row!;
}
const attachmentColumns = (c: DeviceColumns) => ({ epoch: c.epoch, sequence: c.sequence, digest: c.digest, confirmed_at: c.confirmed_at });

/** Every learned row of the org with its row version: equal snapshots mean nothing was inserted, updated or deleted. */
async function learnedSnapshot(orgId: string) {
  return admin<{ t: string; id: string; xmin: string; ctid: string }>(sql`
    SELECT 'learned_networks' AS t, id::text AS id, xmin::text AS xmin, ctid::text AS ctid FROM learned_networks WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'learned_network_gateways', id::text, xmin::text, ctid::text FROM learned_network_gateways WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'learned_network_devices', id::text, xmin::text, ctid::text FROM learned_network_devices WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'learned_network_wan_addresses', id::text, xmin::text, ctid::text FROM learned_network_wan_addresses WHERE org_id = ${orgId}::uuid
    ORDER BY 1, 2`);
}

const OUTCOMES = ['confirm', 'apply', 'apply_failed', 'disabled', 'ephemeral', 'invalid_report', 'stale_sequence',
  'capture_time_out_of_bounds'] as const;
async function counter(): Promise<Record<string, number>> {
  const metric = metricsRegistry.getSingleMetric('breeze_network_attachment_reports_total');
  const out: Record<string, number> = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  if (!metric) return out;
  for (const v of (await metric.get()).values) out[String(v.labels.outcome)] = v.value;
  return out;
}
async function counterDelta<T>(work: () => Promise<T>): Promise<Record<string, number>> {
  const before = await counter();
  await work();
  const after = await counter();
  return Object.fromEntries(Object.keys(after).map((k) => [k, after[k]! - (before[k] ?? 0)]).filter(([, d]) => d !== 0));
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const NO_ROWS = { networks: 0, gateways: 0, members: 0, wan: 0 };
const NO_COLUMNS = { epoch: null, sequence: null, digest: null, confirmed_at: null };
const SKEW_LOG = 'capturedAt outside the accepted bound';

describe('heartbeat route', () => {
  afterEach(async () => {
    clientIp.value = '203.0.113.20';
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await clearStatementFaults();
  });

  it('learns on the first beat and stores the four device columns', async () => {
    const org = await seedOrg('first');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    expect(await counterDelta(() => beat(device, liveReport(418)))).toEqual({ apply: 1 });
    expect(await counts(org.orgId)).toEqual({ networks: 1, gateways: 1, members: 1, wan: 1 });
    const wan = await admin<{ address: string }>(sql`SELECT host(address) AS address FROM learned_network_wan_addresses
      WHERE org_id = ${org.orgId}::uuid`);
    expect(wan).toEqual([{ address: '203.0.113.20' }]);
    const cols = await deviceColumns(device.deviceId);
    expect(cols.epoch).toBe(ROUTE_EPOCH);
    expect(cols.sequence).toBe('418');
    expect(cols.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(cols.confirmed_at).not.toBeNull();
  });

  it("unchanged report adds no write beyond the heartbeat's own", async () => {
    const org = await seedOrg('p8');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    await beat(device, liveReport(1));
    const snapshot = await learnedSnapshot(org.orgId);
    expect(snapshot).toHaveLength(4);
    const first = await deviceColumns(device.deviceId);
    await tick();
    expect(await counterDelta(() => beat(device, liveReport(2)))).toEqual({ confirm: 1 });
    expect(await learnedSnapshot(org.orgId)).toEqual(snapshot);
    const second = await deviceColumns(device.deviceId);
    expect(second.digest).toBe(first.digest);
    expect(second.sequence).toBe('2');
    expect(Date.parse(second.confirmed_at!)).toBeGreaterThan(Date.parse(first.confirmed_at!));
    expect(second.partner_export_updated_at).toBe(first.partner_export_updated_at);
  });

  it('a beat without the field changes nothing and counts nothing', async () => {
    const org = await seedOrg('absent');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    await beat(device, liveReport(418));
    const snapshot = await learnedSnapshot(org.orgId);
    const first = attachmentColumns(await deviceColumns(device.deviceId));
    await tick();
    expect(await counterDelta(() => beat(device, undefined))).toEqual({});
    expect(attachmentColumns(await deviceColumns(device.deviceId))).toEqual(first);
    expect(await learnedSnapshot(org.orgId)).toEqual(snapshot);
  });

  it('capturedAt outside the bound is ignored and counted', async () => {
    const org = await seedOrg('skew');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    const warn = vi.spyOn(console, 'warn');
    const skewLogs = () => warn.mock.calls.filter(([m]) => String(m).includes(SKEW_LOG));
    const behind = liveReport(418, { capturedAt: new Date(Date.now() - 11 * MINUTE) });
    expect(await counterDelta(() => beat(device, behind))).toEqual({ capture_time_out_of_bounds: 1 });
    expect(await counts(org.orgId)).toEqual(NO_ROWS);
    expect(attachmentColumns(await deviceColumns(device.deviceId))).toEqual(NO_COLUMNS);
    expect(skewLogs()).toHaveLength(1);
    expect(skewLogs()[0]![1]).toMatchObject({ deviceId: device.deviceId });
    expect((skewLogs()[0]![1] as { skewSeconds: number }).skewSeconds).toBeLessThanOrEqual(-660);

    // After an earlier beat the previous values stay; the warning is not repeated within the hour.
    await beat(device, liveReport(419));
    const applied = attachmentColumns(await deviceColumns(device.deviceId));
    const ahead = liveReport(420, { capturedAt: new Date(Date.now() + 11 * MINUTE) });
    expect(await counterDelta(() => beat(device, ahead))).toEqual({ capture_time_out_of_bounds: 1 });
    expect(attachmentColumns(await deviceColumns(device.deviceId))).toEqual(applied);
    expect(skewLogs()).toHaveLength(1);
  });

  it('a malformed or stale report is ignored and counted', async () => {
    const org = await seedOrg('malformed');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    expect(await counterDelta(() => beat(device, { epoch: 'nope' }))).toEqual({ invalid_report: 1 });
    expect(await counterDelta(() => beat(device, 'junk'))).toEqual({ invalid_report: 1 });
    await beat(device, liveReport(5));
    expect(await counterDelta(() => beat(device, liveReport(5)))).toEqual({ stale_sequence: 1 });
  });

  it('a learner failure never fails or rolls back the heartbeat', async () => {
    const org = await seedOrg('fault');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    const before = await deviceColumns(device.deviceId);
    await failWritesOn('learned_network_devices');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await tick();
    expect(await counterDelta(() => beat(device, liveReport(1)))).toEqual({ apply_failed: 1 });
    const after = await deviceColumns(device.deviceId);
    expect(Date.parse(after.last_seen_at!)).toBeGreaterThan(Date.parse(before.last_seen_at ?? '1970-01-01'));
    expect(after.digest).toBeNull();
    expect(await counts(org.orgId)).toEqual(NO_ROWS);

    await clearStatementFaults();
    expect(await counterDelta(() => beat(device, liveReport(2)))).toEqual({ apply: 1 });
    expect((await counts(org.orgId)).members).toBe(1);
  });

  it('the watchdog, parked, ephemeral and removed paths learn nothing', async () => {
    const org = await seedOrg('paths');
    // Watchdog and parked beats return before the learner: nothing is planned, so nothing is counted.
    const watchdog = await enrollDevice(org, 'LAPTOP-JS');
    expect(await counterDelta(() => beat(watchdog, liveReport(1), { role: 'watchdog', expectStatus: null }))).toEqual({});
    const parked = await enrollDevice(org, 'DESKTOP-01');
    expect(await counterDelta(() => beat(parked, liveReport(1), { isPreAssignment: true, expectStatus: null }))).toEqual({});
    const ephemeral = await enrollDevice(org, 'LAPTOP-JS');
    await admin(sql`UPDATE devices SET is_ephemeral = true WHERE id = ${ephemeral.deviceId}::uuid`);
    expect(await counterDelta(() => beat(ephemeral, liveReport(1), { expectStatus: null }))).toEqual({ ephemeral: 1 });
    // A removed device in its uninstall drain still beats; its device write matches no row, so it must not learn.
    const removed = await enrollDevice(org, 'DESKTOP-01');
    await admin(sql`UPDATE devices SET status = 'decommissioned' WHERE id = ${removed.deviceId}::uuid`);
    expect(await counterDelta(() => beat(removed, liveReport(1), { expectStatus: null }))).toEqual({});
    const quarantined = await enrollDevice(org, 'LAPTOP-JS');
    await admin(sql`UPDATE devices SET status = 'quarantined' WHERE id = ${quarantined.deviceId}::uuid`);
    expect(await counterDelta(() => beat(quarantined, liveReport(1), { expectStatus: null }))).toEqual({});
    for (const d of [watchdog, parked, ephemeral, removed, quarantined]) {
      expect(attachmentColumns(await deviceColumns(d.deviceId)), d.deviceId).toEqual(NO_COLUMNS);
    }
    expect(await counts(org.orgId)).toEqual(NO_ROWS);
  });

  it('the kill switch stops learning and confirmations, and turning it back on resumes', async () => {
    const org = await seedOrg('killswitch');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false');
    expect(await counterDelta(() => beat(device, liveReport(1)))).toEqual({ disabled: 1 });
    expect(await counts(org.orgId)).toEqual(NO_ROWS);
    expect((await deviceColumns(device.deviceId)).confirmed_at).toBeNull();
    vi.unstubAllEnvs();
    expect(await counterDelta(() => beat(device, liveReport(2)))).toEqual({ apply: 1 });
    const applied = attachmentColumns(await deviceColumns(device.deviceId));

    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false');
    await tick();
    expect(await counterDelta(() => beat(device, liveReport(3)))).toEqual({ disabled: 1 });
    expect(attachmentColumns(await deviceColumns(device.deviceId))).toEqual(applied);
  });

  it('records the WAN address only for a public client address', async () => {
    const org = await seedOrg('wan');
    const device = await enrollDevice(org, 'LAPTOP-JS');
    clientIp.value = '192.168.1.20';
    await beat(device, liveReport(1));
    expect((await counts(org.orgId)).wan).toBe(0);
    clientIp.value = undefined;
    await beat(device, liveReport(2, { attachments: [eth({ localAddress: '192.168.1.58' })] }));
    expect((await counts(org.orgId)).wan).toBe(0);
    clientIp.value = '198.51.100.7';
    await beat(device, liveReport(3, { attachments: [eth({ localAddress: '192.168.1.59' })] }));
    const wan = await admin<{ address: string }>(sql`SELECT host(address) AS address FROM learned_network_wan_addresses
      WHERE org_id = ${org.orgId}::uuid`);
    expect(wan).toEqual([{ address: '198.51.100.7' }]);
  });
});
