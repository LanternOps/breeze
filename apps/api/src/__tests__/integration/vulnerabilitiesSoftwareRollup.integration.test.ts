import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceVulnerabilities,
  organizationUsers,
  softwareInventory,
  softwareProducts,
  softwareVulnerabilities,
  vulnerabilities,
  vulnerabilitySources,
} from '../../db/schema';
import { vulnerabilityRoutes } from '../../routes/vulnerabilities';
import { clearPermissionCache } from '../../services/permissions';
import { fetchFleetFindingRows } from '../../services/vulnerabilityFleetQueries';
import { computeStats, filterFindings, groupFindings } from '../../services/vulnerabilityFleetAggregation';
import { getTestDb } from './setup';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';

/**
 * #2262 — the fleet "By software" queue, its drawer and the stat cards now
 * aggregate in Postgres instead of loading every finding into JS. These tests
 * run the SQL against real Postgres: the drawer's device rollup contract, the
 * lazy per-device drill-down, and a differential check that the SQL list and
 * stats agree with the (still-shipped, device-tab) JS reducers over the same
 * data.
 */

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/vulnerabilities', vulnerabilityRoutes);
  return app;
}

async function get<T>(env: TestEnvironment, path: string): Promise<{ status: number; body: T }> {
  const res = await buildApp().request(`/api/v1/vulnerabilities${path}`, {
    headers: { Authorization: `Bearer ${env.token}` },
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    await db.delete(deviceVulnerabilities);
    await db.delete(softwareVulnerabilities);
    await db.delete(softwareProducts);
    await db.delete(vulnerabilities);
    await db.delete(vulnerabilitySources);
  });
});

let seq = 0;

async function seedDevice(env: TestEnvironment, name: string, opts: { siteId?: string; osType?: 'windows' | 'macos' | 'linux' } = {}) {
  seq += 1;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: opts.siteId ?? env.site.id,
      agentId: `vuln-rollup-${name}-${Date.now()}-${seq}`,
      hostname: name,
      osType: opts.osType ?? 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('failed to seed device');
  return device.id;
}

async function seedInventory(env: TestEnvironment, deviceId: string, name: string, vendor: string | null, version: string | null) {
  const [row] = await getTestDb()
    .insert(softwareInventory)
    .values({ deviceId, orgId: env.organization.id, name, vendor, version })
    .returning({ id: softwareInventory.id });
  if (!row) throw new Error('failed to seed inventory');
  return row.id;
}

async function seedCve(cveId: string, opts: { severity?: 'low' | 'medium' | 'high' | 'critical' | null; kev?: boolean; patch?: boolean; epss?: string | null } = {}) {
  const [row] = await getTestDb()
    .insert(vulnerabilities)
    .values({
      cveId,
      source: 'nvd',
      description: `${cveId} rollup test`,
      severity: opts.severity === undefined ? 'high' : opts.severity,
      cvssVersion: '3.1',
      cvssScore: '7.5',
      epssScore: opts.epss ?? null,
      knownExploited: opts.kev ?? false,
      patchAvailable: opts.patch ?? true,
      rawPayload: { test: true },
    })
    .returning({ id: vulnerabilities.id });
  if (!row) throw new Error('failed to seed cve');
  return row.id;
}

async function seedFinding(env: TestEnvironment, deviceId: string, vulnerabilityId: string, opts: {
  softwareInventoryId?: string | null;
  status?: 'open' | 'patched' | 'mitigated' | 'accepted';
  riskScore?: string;
  acceptedUntil?: Date;
  detectedAt?: Date;
} = {}) {
  const [row] = await getTestDb()
    .insert(deviceVulnerabilities)
    .values({
      orgId: env.organization.id,
      deviceId,
      vulnerabilityId,
      softwareInventoryId: opts.softwareInventoryId ?? null,
      status: opts.status ?? 'open',
      riskScore: opts.riskScore ?? '7.50',
      acceptedUntil: opts.acceptedUntil,
      detectedAt: opts.detectedAt ?? new Date('2026-06-23T12:00:00Z'),
    })
    .returning({ id: deviceVulnerabilities.id });
  if (!row) throw new Error('failed to seed finding');
  return row.id;
}

/**
 * One outdated Chrome on three devices (two on 140, one on 141) with four CVEs
 * each, plus a Firefox finding and a Windows OS finding so the fleet has more
 * than one group. Returns the ids the assertions need.
 */
async function seedChromeFleet(env: TestEnvironment) {
  const d1 = await seedDevice(env, 'rollup-ws-01');
  const d2 = await seedDevice(env, 'rollup-ws-02');
  const d3 = await seedDevice(env, 'rollup-ws-03');
  const chrome1 = await seedInventory(env, d1, 'Google Chrome', 'Google LLC', '140.0.1');
  const chrome2 = await seedInventory(env, d2, 'Google Chrome', 'Google LLC', '140.0.1');
  const chrome3 = await seedInventory(env, d3, 'Google Chrome', 'Google LLC', '141.0.2');
  const firefox1 = await seedInventory(env, d1, 'Mozilla Firefox', 'Mozilla', '120.0');

  const cves = [
    await seedCve('CVE-2026-70001', { severity: 'critical', kev: true, epss: '0.91' }),
    await seedCve('CVE-2026-70002', { severity: 'high', patch: false }),
    await seedCve('CVE-2026-70003', { severity: 'medium', epss: '0.10' }),
    await seedCve('CVE-2026-70004', { severity: null }),
  ];
  const ffCve = await seedCve('CVE-2026-70100', { severity: 'low' });
  const osCve = await seedCve('CVE-2026-70200', { severity: 'high' });

  const open: Record<string, string[]> = { [d1]: [], [d2]: [], [d3]: [] };
  let accepted = '';
  const inventory: Record<string, string> = { [d1]: chrome1, [d2]: chrome2, [d3]: chrome3 };
  for (const deviceId of [d1, d2, d3]) {
    for (const [i, vulnId] of cves.entries()) {
      // d1's CVE-70003 is an accepted-risk waiver; everything else is open.
      if (deviceId === d1 && i === 2) {
        accepted = await seedFinding(env, deviceId, vulnId, {
          softwareInventoryId: inventory[deviceId],
          status: 'accepted',
          acceptedUntil: new Date(Date.now() + 5 * 864e5),
          riskScore: '5.00',
        });
        continue;
      }
      open[deviceId]!.push(
        await seedFinding(env, deviceId, vulnId, {
          softwareInventoryId: inventory[deviceId],
          riskScore: (9 - i).toFixed(2),
        }),
      );
    }
  }
  await seedFinding(env, d1, ffCve, { softwareInventoryId: firefox1, riskScore: '3.00' });
  await seedFinding(env, d2, osCve, { softwareInventoryId: null, riskScore: '8.00', status: 'mitigated' });

  return { d1, d2, d3, cves, open, accepted };
}

const CHROME_KEY = 'sw:google chrome|google llc';

/** Strip fields whose value the JS reducer picks from an arbitrary "first" row
 *  so the differential compare only covers deterministic fields. */
function comparable<T extends { tickets: unknown }>(groups: T[]) {
  return groups.map((g) => ({ ...g, tickets: [] }));
}

describe('fleet software rollup (#2262)', () => {
  runDb('GET /software/:groupKey returns one row per DEVICE, not per device x CVE', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const { d1, d2, d3, open } = await seedChromeFleet(env);

    const { status, body } = await get<Record<string, unknown> & {
      group: { deviceCount: number; cveCount: number; versions: string[] };
      cves: Array<{ cveId: string; deviceCount: number; openDeviceCount: number }>;
      versions: Array<{ version: string; deviceCount: number }>;
      devices: Array<{
        deviceId: string;
        deviceName: string;
        installedVersions: string[];
        cveCount: number;
        openFindingCount: number;
        acceptedFindingCount: number;
        patchReadyFindingCount: number;
        worstOpenSeverity: string | null;
        maxOpenRiskScore: number | null;
        openFindingIds: string[];
      }>;
    }>(env, `/software/${encodeURIComponent(CHROME_KEY)}`);

    expect(status).toBe(200);
    // The per-device-per-CVE list is gone from the payload.
    expect(body).not.toHaveProperty('findings');
    expect(body.group.deviceCount).toBe(3);
    expect(body.group.cveCount).toBe(4);

    expect(body.devices.map((d) => d.deviceName)).toEqual(['rollup-ws-01', 'rollup-ws-02', 'rollup-ws-03']);
    const byId = new Map(body.devices.map((d) => [d.deviceId, d]));
    const dev1 = byId.get(d1)!;
    expect(dev1.cveCount).toBe(4);
    expect(dev1.openFindingCount).toBe(3);
    expect(dev1.acceptedFindingCount).toBe(1);
    // CVE-70002 has no patch → 2 of d1's 3 open findings are patch-ready.
    expect(dev1.patchReadyFindingCount).toBe(2);
    expect(dev1.worstOpenSeverity).toBe('critical');
    expect(dev1.maxOpenRiskScore).toBe(9);
    expect(dev1.installedVersions).toEqual(['140.0.1']);
    // Exactly the open ids — never the accepted one.
    expect([...dev1.openFindingIds].sort()).toEqual([...open[d1]!].sort());
    expect(byId.get(d2)!.openFindingIds.sort()).toEqual([...open[d2]!].sort());
    expect(byId.get(d3)!.installedVersions).toEqual(['141.0.2']);

    expect(body.versions).toEqual([
      { version: '140.0.1', deviceCount: 2 },
      { version: '141.0.2', deviceCount: 1 },
    ]);

    const cve3 = body.cves.find((c) => c.cveId === 'CVE-2026-70003')!;
    expect(cve3.deviceCount).toBe(3);
    expect(cve3.openDeviceCount).toBe(2);
    expect(body.cves.find((c) => c.cveId === 'CVE-2026-70001')!.openDeviceCount).toBe(3);
  });

  runDb('GET /software/:groupKey 404s for a group the caller has no findings in', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedChromeFleet(env);
    const other = await setupTestEnvironment({ scope: 'organization' });
    const { status } = await get(other, `/software/${encodeURIComponent(CHROME_KEY)}`);
    expect(status).toBe(404);
  });

  runDb('GET /software/:groupKey/devices/:deviceId drills into ONE device\'s findings in the group', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const { d1, accepted } = await seedChromeFleet(env);

    const { status, body } = await get<{ findings: Array<{ deviceId: string; cveId: string; status: string; deviceVulnerabilityId: string }> }>(
      env,
      `/software/${encodeURIComponent(CHROME_KEY)}/devices/${d1}`,
    );
    expect(status).toBe(200);
    // 4 Chrome findings (3 open + 1 accepted) — the Firefox finding on the same
    // device belongs to another group and must not appear.
    expect(body.findings).toHaveLength(4);
    expect(body.findings.every((f) => f.deviceId === d1)).toBe(true);
    expect(body.findings.map((f) => f.cveId).sort()).toEqual([
      'CVE-2026-70001',
      'CVE-2026-70002',
      'CVE-2026-70003',
      'CVE-2026-70004',
    ]);
    expect(body.findings.find((f) => f.deviceVulnerabilityId === accepted)?.status).toBe('accepted');
  });

  runDb('drill-down does not reach a device outside the caller\'s org or allowed sites', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const { d1 } = await seedChromeFleet(env);

    const foreign = await setupTestEnvironment({ scope: 'organization' });
    const cross = await get<{ findings: unknown[] }>(foreign, `/software/${encodeURIComponent(CHROME_KEY)}/devices/${d1}`);
    expect(cross.status).toBe(200);
    expect(cross.body.findings).toEqual([]);

    // Same org, but restricted to a different site → nothing.
    const siteB = await createSite({ orgId: env.organization.id, name: 'Rollup Site B' });
    await withSystemDbAccessContext(async () => {
      await db
        .update(organizationUsers)
        .set({ siteIds: [siteB.id] })
        .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
    });
    await clearPermissionCache(env.user.id);
    const siteDenied = await get<{ findings: unknown[] }>(env, `/software/${encodeURIComponent(CHROME_KEY)}/devices/${d1}`);
    expect(siteDenied.status).toBe(200);
    expect(siteDenied.body.findings).toEqual([]);
    const drawerDenied = await get(env, `/software/${encodeURIComponent(CHROME_KEY)}`);
    expect(drawerDenied.status).toBe(404);
  });

  // Differential: the SQL aggregation must reproduce what the JS reducer
  // produced from the full row set, for every filter the route accepts.
  const FILTER_CASES: Array<{ qs: string; filters: Parameters<typeof filterFindings>[1]; search?: string }> = [
    { qs: '', filters: { status: 'open' } },
    { qs: '?status=all', filters: { status: 'all' } },
    { qs: '?status=accepted', filters: { status: 'accepted' } },
    { qs: '?status=mitigated', filters: { status: 'mitigated' } },
    { qs: '?status=all&severity=critical', filters: { status: 'all', severity: 'critical' } },
    { qs: '?status=all&kevOnly=true', filters: { status: 'all', kevOnly: true } },
    { qs: '?status=all&patchAvailable=true', filters: { status: 'all', patchAvailable: true } },
    { qs: '?status=accepted&expiringWithinDays=14', filters: { status: 'accepted', expiringWithinDays: 14 } },
    { qs: '?status=accepted&expiringWithinDays=1', filters: { status: 'accepted', expiringWithinDays: 1 } },
    { qs: '?status=all&search=chrome', filters: { status: 'all' }, search: 'chrome' },
    { qs: '?status=all&search=cve-2026-701', filters: { status: 'all' }, search: 'cve-2026-701' },
    { qs: '?status=all&search=windows', filters: { status: 'all' }, search: 'windows' },
  ];

  runDb('GET /software (SQL) matches the JS reducer across every filter', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedChromeFleet(env);

    const rows = await withSystemDbAccessContext(() =>
      fetchFleetFindingRows({ status: 'all', orgId: env.organization.id }),
    );
    for (const c of FILTER_CASES) {
      const expected = groupFindings(filterFindings(rows, c.filters), { search: c.search });
      const { status, body } = await get<{ items: Parameters<typeof comparable>[0]; hasMore: boolean }>(env, `/software${c.qs}`);
      expect(status, c.qs).toBe(200);
      expect(comparable(body.items), c.qs).toEqual(comparable(expected));
      expect(body.hasMore).toBe(false);
    }
  });

  runDb('GET /stats (SQL) matches the JS reducer', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedChromeFleet(env);

    const rows = await withSystemDbAccessContext(() =>
      fetchFleetFindingRows({ status: 'all', orgId: env.organization.id }),
    );
    const expected = computeStats(rows, new Date());
    const { status, body } = await get(env, '/stats');
    expect(status).toBe(200);
    expect(body).toEqual(expected);
    // Sanity: the fixture actually exercises every card.
    expect(expected.criticalOpen).toBe(3);
    expect(expected.kevCveCount).toBe(1);
    expect(expected.kevDeviceCount).toBe(3);
    expect(expected.acceptedExpiringSoon).toBe(1);
  });

  runDb('an OS finding (no software link) groups under os:<platform>', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const { d2 } = await seedChromeFleet(env);
    const { status, body } = await get<{ group: { name: string; kind: string }; devices: Array<{ deviceId: string; mitigatedFindingCount: number; openFindingIds: string[] }> }>(
      env,
      `/software/${encodeURIComponent('os:windows')}`,
    );
    expect(status).toBe(200);
    expect(body.group).toMatchObject({ kind: 'os', name: 'Windows OS updates' });
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ deviceId: d2, mitigatedFindingCount: 1, openFindingIds: [] });
  });
});
