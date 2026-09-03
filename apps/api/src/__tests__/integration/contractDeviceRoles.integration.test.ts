/**
 * #3205 — device-role counting against a real Postgres as breeze_app.
 * Own fixture (not contractQuantities.integration.test.ts) so the existing
 * org-wide / per-site assertions there stay untouched.
 *
 * Fixture: partner → org → siteA + siteB
 *   w1 workstation A  | w2 workstation B | s1 server A | sw1 switch B
 *   u1 (role default 'unknown') A
 *   s2 server A decommissioned (excluded) | s3 server A ephemeral (excluded)
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices } from '../../db/schema';
import { countContractDevices, snapshotContractDevices } from '../../services/contractQuantities';

async function seed(): Promise<{ orgId: string; siteAId: string; siteBId: string; deviceIds: Record<string, string> }> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `RP ${sfx}`, slug: `rp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'ROrg', slug: `ro-${sfx}` })
      .returning({ id: organizations.id });
    const orgId = o!.id;
    const [sA, sB] = await db.insert(sites)
      .values([{ orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` }])
      .returning({ id: sites.id });
    const base = { orgId, osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' };
    const inserted = await db.insert(devices).values([
      { ...base, siteId: sA!.id, agentId: `w1-${sfx}`, hostname: 'w1', status: 'online', deviceRole: 'workstation' },
      { ...base, siteId: sB!.id, agentId: `w2-${sfx}`, hostname: 'w2', status: 'online', deviceRole: 'workstation' },
      { ...base, siteId: sA!.id, agentId: `s1-${sfx}`, hostname: 's1', status: 'online', deviceRole: 'server' },
      { ...base, siteId: sB!.id, agentId: `sw1-${sfx}`, hostname: 'sw1', status: 'offline', deviceRole: 'switch' },
      { ...base, siteId: sA!.id, agentId: `u1-${sfx}`, hostname: 'u1', status: 'online' }, // deviceRole default 'unknown'
      { ...base, siteId: sA!.id, agentId: `s2-${sfx}`, hostname: 's2', status: 'decommissioned', deviceRole: 'server' },
      { ...base, siteId: sA!.id, agentId: `s3-${sfx}`, hostname: 's3', status: 'online', deviceRole: 'server', isEphemeral: true },
    ]).returning({ id: devices.id, hostname: devices.hostname });
    return {
      orgId,
      siteAId: sA!.id,
      siteBId: sB!.id,
      deviceIds: Object.fromEntries(inserted.map((device) => [device.hostname, device.id])),
    };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('device-role contract counting (breeze_app, real DB) #3205', () => {
  runDb('countContractDevices without roles is unchanged (5 billable)', async () => {
    const { orgId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null))).toBe(5);
  });

  runDb('filters by a single role and excludes decommissioned + ephemeral', async () => {
    const { orgId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null, ['server']))).toBe(1);
  });

  runDb('filters by a role set', async () => {
    const { orgId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null, ['workstation', 'server']))).toBe(3);
  });

  runDb('rejects an explicitly empty role filter', async () => {
    const { orgId } = await seed();
    await expect(withSystemDbAccessContext(() => countContractDevices(orgId, null, []))).rejects.toThrow(/non-empty/);
  });

  runDb('site narrowing composes with roles', async () => {
    const { orgId, siteAId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, siteAId, ['workstation']))).toBe(1);
  });

  runDb('snapshotContractDevices returns one row per billable device', async () => {
    const { orgId, siteAId, siteBId, deviceIds } = await seed();
    const snap = await withSystemDbAccessContext(() => snapshotContractDevices(orgId));
    const sorted = [...snap].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted).toEqual([
      { id: deviceIds.s1, role: 'server', siteId: siteAId },
      { id: deviceIds.sw1, role: 'switch', siteId: siteBId },
      { id: deviceIds.u1, role: 'unknown', siteId: siteAId },
      { id: deviceIds.w1, role: 'workstation', siteId: siteAId },
      { id: deviceIds.w2, role: 'workstation', siteId: siteBId },
    ].sort((a, b) => a.id!.localeCompare(b.id!)));
    expect(snap).toHaveLength(5);
  });
});
