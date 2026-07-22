import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceVulnerabilities,
  organizationUsers,
  softwareProducts,
  softwareVulnerabilities,
  vulnerabilities,
  vulnerabilitySources,
} from '../../db/schema';
import { vulnerabilityRoutes } from '../../routes/vulnerabilities';
import { clearPermissionCache } from '../../services/permissions';
import { getTestDb } from './setup';
import { createOrganization, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/vulnerabilities', vulnerabilityRoutes);
  return app;
}

function authHeaders(env: TestEnvironment) {
  return { Authorization: `Bearer ${env.token}` };
}

async function postJson(env: TestEnvironment, path: string, body: unknown): Promise<Response> {
  return buildApp().request(path, {
    method: 'POST',
    headers: { ...authHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Read a device_vulnerabilities row bypassing RLS, to verify persisted state. */
async function readFinding(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(deviceVulnerabilities)
      .where(eq(deviceVulnerabilities.id, id))
      .limit(1);
    return row;
  });
}

/** Restrict an org-scope user to a specific set of sites (drives allowedSiteIds). */
async function restrictUserToSites(env: TestEnvironment, siteIds: string[]) {
  await withSystemDbAccessContext(async () => {
    await db
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
  });
  // Permissions (incl. allowedSiteIds) are hot-cached per user — invalidate so
  // the next request re-resolves the mutated membership.
  await clearPermissionCache(env.user.id);
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

async function seedDevice(env: TestEnvironment, suffix: string, siteId?: string): Promise<string> {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: siteId ?? env.site.id,
      agentId: `vuln-route-agent-${suffix}-${Date.now()}`,
      hostname: `vuln-route-host-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });

  if (!device) throw new Error('failed to seed device');
  return device.id;
}

async function seedCatalogVulnerability(opts: {
  cveId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  cvssScore: string;
  knownExploited?: boolean;
  patchAvailable?: boolean;
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(vulnerabilities)
    .values({
      cveId: opts.cveId,
      source: 'msrc',
      description: `${opts.cveId} route test vulnerability`,
      severity: opts.severity,
      cvssVersion: '3.1',
      cvssScore: opts.cvssScore,
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      knownExploited: opts.knownExploited ?? false,
      patchAvailable: opts.patchAvailable ?? true,
      rawPayload: { test: true },
    })
    .returning({ id: vulnerabilities.id });

  if (!row) throw new Error('failed to seed vulnerability');
  return row.id;
}

async function seedDeviceFinding(opts: {
  orgId: string;
  deviceId: string;
  vulnerabilityId: string;
  status?: 'open' | 'patched' | 'mitigated' | 'accepted';
  riskScore?: string;
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceVulnerabilities)
    .values({
      orgId: opts.orgId,
      deviceId: opts.deviceId,
      vulnerabilityId: opts.vulnerabilityId,
      status: opts.status ?? 'open',
      riskScore: opts.riskScore,
      detectedAt: new Date('2026-06-23T12:00:00Z'),
    })
    .returning({ id: deviceVulnerabilities.id });

  if (!row) throw new Error('failed to seed device vulnerability');
  return row.id;
}

describe('vulnerabilityRoutes', () => {
  // ── Fleet endpoint (GET /) — now returns server-side aggregated rows ──

  runDb(
    'GET /api/v1/vulnerabilities returns aggregated fleet rows (one per CVE with deviceCount)',
    async () => {
      const envA = await setupTestEnvironment({ scope: 'organization' });
      const envB = await setupTestEnvironment({ scope: 'organization' });
      const deviceA1 = await seedDevice(envA, 'agg-a1');
      const deviceA2 = await seedDevice(envA, 'agg-a2');
      const deviceB = await seedDevice(envB, 'agg-b');

      const criticalVuln = await seedCatalogVulnerability({
        cveId: 'CVE-2026-10002',
        severity: 'critical',
        cvssScore: '9.8',
        knownExploited: true,
      });
      const highVuln = await seedCatalogVulnerability({
        cveId: 'CVE-2026-10001',
        severity: 'high',
        cvssScore: '7.5',
      });
      const otherOrg = await seedCatalogVulnerability({
        cveId: 'CVE-2026-10004',
        severity: 'critical',
        cvssScore: '9.9',
      });

      // criticalVuln affects TWO devices in org A
      await seedDeviceFinding({
        orgId: envA.organization.id,
        deviceId: deviceA1,
        vulnerabilityId: criticalVuln,
        riskScore: '9.80',
      });
      await seedDeviceFinding({
        orgId: envA.organization.id,
        deviceId: deviceA2,
        vulnerabilityId: criticalVuln,
        riskScore: '9.80',
      });
      // highVuln affects ONE device in org A
      await seedDeviceFinding({
        orgId: envA.organization.id,
        deviceId: deviceA1,
        vulnerabilityId: highVuln,
        riskScore: '7.50',
      });
      // otherOrg belongs to org B — must NOT appear in org A response
      await seedDeviceFinding({
        orgId: envB.organization.id,
        deviceId: deviceB,
        vulnerabilityId: otherOrg,
        riskScore: '9.90',
      });

      const res = await buildApp().request('/api/v1/vulnerabilities', {
        headers: authHeaders(envA),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        items: Array<{
          id: string;
          cveId: string;
          cvssScore: number | null;
          severity: string | null;
          knownExploited: boolean;
          epssScore: number | null;
          riskScore: number | null;
          deviceCount: number;
          patchAvailable: boolean;
          statuses: string[];
        }>;
      };

      // Only org A's two CVEs returned
      expect(body.items).toHaveLength(2);

      // Fleet rows have the aggregated shape — CVE metadata plus deviceCount,
      // patchAvailable, and aggregated statuses; never a per-device deviceId or singular status
      const firstItem = body.items[0]!;
      expect(firstItem).toHaveProperty('id');
      expect(firstItem).toHaveProperty('cveId');
      expect(firstItem).toHaveProperty('cvssScore');
      expect(firstItem).toHaveProperty('severity');
      expect(firstItem).toHaveProperty('knownExploited');
      expect(firstItem).toHaveProperty('epssScore');
      expect(firstItem).toHaveProperty('riskScore');
      expect(firstItem).toHaveProperty('deviceCount');
      expect(firstItem).toHaveProperty('patchAvailable');
      expect(firstItem).toHaveProperty('statuses');
      expect(firstItem).not.toHaveProperty('deviceId');
      expect(firstItem).not.toHaveProperty('status');

      // criticalVuln (riskScore 9.8) sorts first
      expect(body.items[0]!.cveId).toBe('CVE-2026-10002');
      // criticalVuln affected 2 devices
      expect(body.items[0]!.deviceCount).toBe(2);
      // highVuln affected 1 device
      expect(body.items[1]!.cveId).toBe('CVE-2026-10001');
      expect(body.items[1]!.deviceCount).toBe(1);
    },
  );

  runDb(
    'GET /api/v1/vulnerabilities fleet sort: riskScore DESC, then knownExploited (true first)',
    async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const deviceId = await seedDevice(env, 'fleet-sort');

      // Both same riskScore; kev=true should come first
      const kev = await seedCatalogVulnerability({
        cveId: 'CVE-2026-60002',
        severity: 'critical',
        cvssScore: '9.0',
        knownExploited: true,
      });
      const noKev = await seedCatalogVulnerability({
        cveId: 'CVE-2026-60001',
        severity: 'critical',
        cvssScore: '9.0',
        knownExploited: false,
      });

      await seedDeviceFinding({ orgId: env.organization.id, deviceId, vulnerabilityId: kev, riskScore: '9.00' });
      await seedDeviceFinding({ orgId: env.organization.id, deviceId, vulnerabilityId: noKev, riskScore: '9.00' });

      const res = await buildApp().request('/api/v1/vulnerabilities', {
        headers: authHeaders(env),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ cveId: string; knownExploited: boolean }> };
      expect(body.items[0]!.cveId).toBe('CVE-2026-60002');
      expect(body.items[0]!.knownExploited).toBe(true);
    },
  );

  runDb('GET /api/v1/vulnerabilities?status=all returns all statuses aggregated for the caller org', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await seedDevice(env, 'all-statuses');

    const openVuln = await seedCatalogVulnerability({
      cveId: 'CVE-2026-50001',
      severity: 'high',
      cvssScore: '7.5',
    });
    const patchedVuln = await seedCatalogVulnerability({
      cveId: 'CVE-2026-50002',
      severity: 'high',
      cvssScore: '7.4',
    });
    const mitigatedVuln = await seedCatalogVulnerability({
      cveId: 'CVE-2026-50003',
      severity: 'medium',
      cvssScore: '6.0',
    });

    await seedDeviceFinding({ orgId: env.organization.id, deviceId, vulnerabilityId: openVuln, status: 'open' });
    await seedDeviceFinding({ orgId: env.organization.id, deviceId, vulnerabilityId: patchedVuln, status: 'patched' });
    await seedDeviceFinding({ orgId: env.organization.id, deviceId, vulnerabilityId: mitigatedVuln, status: 'mitigated' });

    const res = await buildApp().request('/api/v1/vulnerabilities?status=all', {
      headers: authHeaders(env),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ cveId: string; deviceCount: number }> };
    // All three CVEs collapsed into aggregated rows (one per CVE)
    const cveIds = body.items.map((item) => item.cveId).sort();
    expect(cveIds).toEqual(['CVE-2026-50001', 'CVE-2026-50002', 'CVE-2026-50003'].sort());
    // Each CVE has exactly one device
    expect(body.items.every((item) => item.deviceCount === 1)).toBe(true);
  });

  runDb('GET /api/v1/vulnerabilities?status=all does not leak cross-org rows', async () => {
    const envA = await setupTestEnvironment({ scope: 'organization' });
    const envB = await setupTestEnvironment({ scope: 'organization' });
    const deviceA = await seedDevice(envA, 'all-leak-a');
    const deviceB = await seedDevice(envB, 'all-leak-b');

    const vulnA = await seedCatalogVulnerability({ cveId: 'CVE-2026-51001', severity: 'high', cvssScore: '7.5' });
    const vulnB = await seedCatalogVulnerability({ cveId: 'CVE-2026-51002', severity: 'high', cvssScore: '7.4' });

    await seedDeviceFinding({ orgId: envA.organization.id, deviceId: deviceA, vulnerabilityId: vulnA, status: 'open' });
    await seedDeviceFinding({ orgId: envB.organization.id, deviceId: deviceB, vulnerabilityId: vulnB, status: 'mitigated' });

    const res = await buildApp().request('/api/v1/vulnerabilities?status=all', {
      headers: authHeaders(envA),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ cveId: string }> };
    expect(body.items.map((item) => item.cveId)).toEqual(['CVE-2026-51001']);
  });

  runDb('GET /api/v1/vulnerabilities supports severity and CVE catalog filters', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await seedDevice(env, 'filter');
    const critical = await seedCatalogVulnerability({
      cveId: 'CVE-2026-20001',
      severity: 'critical',
      cvssScore: '9.1',
    });
    const high = await seedCatalogVulnerability({
      cveId: 'CVE-2026-20002',
      severity: 'high',
      cvssScore: '8.8',
    });

    await seedDeviceFinding({
      orgId: env.organization.id,
      deviceId,
      vulnerabilityId: critical,
      riskScore: '9.10',
    });
    await seedDeviceFinding({
      orgId: env.organization.id,
      deviceId,
      vulnerabilityId: high,
      riskScore: '8.80',
    });

    const res = await buildApp().request(
      '/api/v1/vulnerabilities?severity=critical&cve=CVE-2026-20001',
      { headers: authHeaders(env) },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ cveId: string; severity: string; deviceCount: number }> };
    expect(body.items).toEqual([
      expect.objectContaining({ cveId: 'CVE-2026-20001', severity: 'critical', deviceCount: 1 }),
    ]);
  });

  // ── Per-device endpoint (GET /devices/:deviceId) ──

  runDb(
    'GET /api/v1/vulnerabilities/devices/:deviceId returns per-device rows sorted by riskScore DESC, includes patchAvailable',
    async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const targetDeviceId = await seedDevice(env, 'target-sort');

      const highRisk = await seedCatalogVulnerability({
        cveId: 'CVE-2026-70002',
        severity: 'critical',
        cvssScore: '9.5',
        patchAvailable: true,
      });
      const lowRisk = await seedCatalogVulnerability({
        cveId: 'CVE-2026-70001',
        severity: 'high',
        cvssScore: '7.0',
        patchAvailable: false,
      });

      // Insert in reverse order to confirm sort is by riskScore not DB order
      await seedDeviceFinding({
        orgId: env.organization.id,
        deviceId: targetDeviceId,
        vulnerabilityId: lowRisk,
        riskScore: '7.00',
      });
      await seedDeviceFinding({
        orgId: env.organization.id,
        deviceId: targetDeviceId,
        vulnerabilityId: highRisk,
        riskScore: '9.50',
      });

      const res = await buildApp().request(`/api/v1/vulnerabilities/devices/${targetDeviceId}`, {
        headers: authHeaders(env),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        items: Array<{
          cveId: string;
          deviceId: string;
          riskScore: number | null;
          patchAvailable: boolean;
        }>;
      };

      expect(body.items).toHaveLength(2);

      // Sorted by riskScore DESC: highRisk (9.5) first
      expect(body.items[0]!.cveId).toBe('CVE-2026-70002');
      expect(body.items[0]!.riskScore).toBe(9.5);
      expect(body.items[0]!.patchAvailable).toBe(true);

      expect(body.items[1]!.cveId).toBe('CVE-2026-70001');
      expect(body.items[1]!.riskScore).toBe(7);
      expect(body.items[1]!.patchAvailable).toBe(false);

      // Both belong to the target device
      expect(body.items.every((item) => item.deviceId === targetDeviceId)).toBe(true);
    },
  );

  runDb(
    'GET /api/v1/vulnerabilities/devices/:deviceId tie-breaks by cveId ASC when riskScore equal',
    async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const targetDeviceId = await seedDevice(env, 'target-tie');

      const vulnB = await seedCatalogVulnerability({
        cveId: 'CVE-2026-80002',
        severity: 'high',
        cvssScore: '8.0',
      });
      const vulnA = await seedCatalogVulnerability({
        cveId: 'CVE-2026-80001',
        severity: 'high',
        cvssScore: '8.0',
      });

      // Insert B before A; equal riskScore → should sort by cveId ASC
      await seedDeviceFinding({ orgId: env.organization.id, deviceId: targetDeviceId, vulnerabilityId: vulnB, riskScore: '8.00' });
      await seedDeviceFinding({ orgId: env.organization.id, deviceId: targetDeviceId, vulnerabilityId: vulnA, riskScore: '8.00' });

      const res = await buildApp().request(`/api/v1/vulnerabilities/devices/${targetDeviceId}`, {
        headers: authHeaders(env),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ cveId: string }> };
      expect(body.items.map((i) => i.cveId)).toEqual(['CVE-2026-80001', 'CVE-2026-80002']);
    },
  );

  runDb('GET /api/v1/vulnerabilities/devices/:deviceId returns only that device open findings', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const targetDeviceId = await seedDevice(env, 'target');
    const otherDeviceId = await seedDevice(env, 'other');

    const targetOpen = await seedCatalogVulnerability({
      cveId: 'CVE-2026-30001',
      severity: 'critical',
      cvssScore: '9.3',
    });
    const targetPatched = await seedCatalogVulnerability({
      cveId: 'CVE-2026-30002',
      severity: 'critical',
      cvssScore: '9.4',
    });
    const otherOpen = await seedCatalogVulnerability({
      cveId: 'CVE-2026-30003',
      severity: 'high',
      cvssScore: '8.0',
    });

    await seedDeviceFinding({
      orgId: env.organization.id,
      deviceId: targetDeviceId,
      vulnerabilityId: targetOpen,
      riskScore: '9.30',
    });
    await seedDeviceFinding({
      orgId: env.organization.id,
      deviceId: targetDeviceId,
      vulnerabilityId: targetPatched,
      status: 'patched',
      riskScore: '9.40',
    });
    await seedDeviceFinding({
      orgId: env.organization.id,
      deviceId: otherDeviceId,
      vulnerabilityId: otherOpen,
      riskScore: '8.00',
    });

    const res = await buildApp().request(`/api/v1/vulnerabilities/devices/${targetDeviceId}`, {
      headers: authHeaders(env),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ cveId: string; deviceId: string; status: string; patchAvailable: boolean }> };
    expect(body.items).toEqual([
      expect.objectContaining({
        cveId: 'CVE-2026-30001',
        deviceId: targetDeviceId,
        status: 'open',
        patchAvailable: true,
      }),
    ]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // fetchFleetFindingRows-backed endpoints (GET /software, GET /stats) exercised
  // against the REAL DB layer. Every unit test mocks this query; these prove the
  // org-RLS + system-context catalog join actually runs end-to-end.
  // ──────────────────────────────────────────────────────────────────────────

  // System-context catalog join returns data: a regression that breaks the
  // runOutsideDbContext+withSystemDbAccessContext catalog read makes every
  // finding look orphaned (catalog row missing) and the queue silently empty.
  runDb('GET /api/v1/vulnerabilities/software returns findings (system-context catalog join works)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await seedDevice(env, 'sw-join');
    const vuln = await seedCatalogVulnerability({
      cveId: 'CVE-2026-90001',
      severity: 'critical',
      cvssScore: '9.5',
      knownExploited: true,
      patchAvailable: true,
    });
    await seedDeviceFinding({ orgId: env.organization.id, deviceId, vulnerabilityId: vuln, riskScore: '9.50' });

    const res = await buildApp().request('/api/v1/vulnerabilities/software', { headers: authHeaders(env) });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ deviceCount: number; cveIds: string[] }> };
    // Not empty — the catalog join resolved the CVE so the finding stayed in the queue.
    expect(body.items.length).toBeGreaterThan(0);
    const totalDevices = body.items.reduce((sum, g) => sum + g.deviceCount, 0);
    expect(totalDevices).toBe(1);
    expect(body.items.some((g) => g.cveIds.includes('CVE-2026-90001'))).toBe(true);
  });

  // C2: cross-org isolation of the fleet queue. The software group key collapses
  // same-product findings across orgs, so a leak here is fleet-wide. Seed findings
  // in TWO orgs and prove an org-A caller sees only org-A rows/counts.
  runDb('GET /software and GET /stats do not leak another org\'s findings into the fleet queue', async () => {
    const envA = await setupTestEnvironment({ scope: 'organization' });
    const envB = await setupTestEnvironment({ scope: 'organization' });
    const deviceA = await seedDevice(envA, 'iso-a');
    const deviceB = await seedDevice(envB, 'iso-b');

    // Org A: a plain high finding, no KEV. Org B: a KEV critical finding — if it
    // leaked, org A's kev/critical counts would be inflated.
    const vulnA = await seedCatalogVulnerability({ cveId: 'CVE-2026-91001', severity: 'high', cvssScore: '7.5' });
    const vulnB = await seedCatalogVulnerability({
      cveId: 'CVE-2026-91002',
      severity: 'critical',
      cvssScore: '9.9',
      knownExploited: true,
    });
    await seedDeviceFinding({ orgId: envA.organization.id, deviceId: deviceA, vulnerabilityId: vulnA, riskScore: '7.50' });
    await seedDeviceFinding({ orgId: envB.organization.id, deviceId: deviceB, vulnerabilityId: vulnB, riskScore: '9.90' });

    const swRes = await buildApp().request('/api/v1/vulnerabilities/software', { headers: authHeaders(envA) });
    expect(swRes.status).toBe(200);
    const swBody = await swRes.json() as { items: Array<{ deviceCount: number; cveIds: string[]; kevCveCount: number }> };
    // Exactly org A's single device across all groups; org B's device never appears.
    expect(swBody.items.reduce((sum, g) => sum + g.deviceCount, 0)).toBe(1);
    expect(swBody.items.some((g) => g.cveIds.includes('CVE-2026-91002'))).toBe(false);
    expect(swBody.items.every((g) => g.kevCveCount === 0)).toBe(true);

    const statsRes = await buildApp().request('/api/v1/vulnerabilities/stats', { headers: authHeaders(envA) });
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json() as {
      totalFindings: number;
      criticalOpen: number;
      kevCveCount: number;
      kevDeviceCount: number;
    };
    expect(stats.totalFindings).toBe(1); // only org A's finding
    expect(stats.criticalOpen).toBe(0); // org B's critical must not leak
    expect(stats.kevCveCount).toBe(0);
    expect(stats.kevDeviceCount).toBe(0);
  });

  // Site narrowing + fail-closed: an org-scope caller restricted to a site sees
  // only that site's findings; an empty allowed-sites set returns nothing.
  runDb('GET /software narrows to the caller\'s allowed sites and fails closed when empty', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const siteB = await createSite({ orgId: env.organization.id, name: 'Second Site' });
    const deviceInSiteA = await seedDevice(env, 'site-a', env.site.id);
    const deviceInSiteB = await seedDevice(env, 'site-b', siteB.id);

    const vulnA = await seedCatalogVulnerability({ cveId: 'CVE-2026-92001', severity: 'high', cvssScore: '7.5' });
    const vulnB = await seedCatalogVulnerability({ cveId: 'CVE-2026-92002', severity: 'high', cvssScore: '7.4' });
    await seedDeviceFinding({ orgId: env.organization.id, deviceId: deviceInSiteA, vulnerabilityId: vulnA, riskScore: '7.50' });
    await seedDeviceFinding({ orgId: env.organization.id, deviceId: deviceInSiteB, vulnerabilityId: vulnB, riskScore: '7.40' });

    // Restrict to site A only: only site-A's finding is visible.
    await restrictUserToSites(env, [env.site.id]);
    const narrowedRes = await buildApp().request('/api/v1/vulnerabilities/software', { headers: authHeaders(env) });
    expect(narrowedRes.status).toBe(200);
    const narrowed = await narrowedRes.json() as { items: Array<{ deviceCount: number; cveIds: string[] }> };
    expect(narrowed.items.reduce((sum, g) => sum + g.deviceCount, 0)).toBe(1);
    expect(narrowed.items.some((g) => g.cveIds.includes('CVE-2026-92002'))).toBe(false);

    // Empty allowed-sites → fail closed (no findings at all).
    await restrictUserToSites(env, []);
    const closedRes = await buildApp().request('/api/v1/vulnerabilities/software', { headers: authHeaders(env) });
    expect(closedRes.status).toBe(200);
    const closed = await closedRes.json() as { items: unknown[] };
    expect(closed.items).toEqual([]);
  });

  // Org-selector narrowing (?orgId=, auto-injected by the web client): a partner
  // caller with two orgs gets only the selected org's rows. Every unit test
  // mocks the query layer, so this is the only place the eq(org_id) narrowing
  // is proven against real Postgres — review mutation showed deleting it kept
  // the unit suite green.
  runDb('fleet reads narrow to ?orgId= for a partner-scope caller (and 403 an inaccessible org)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgB = await createOrganization({ partnerId: env.partner.id });
    const siteB = await createSite({ orgId: orgB.id });

    const deviceA = await seedDevice(env, 'orgsel-a');
    const [deviceB] = await getTestDb()
      .insert(devices)
      .values({
        orgId: orgB.id,
        siteId: siteB.id,
        agentId: `vuln-route-agent-orgsel-b-${Date.now()}`,
        hostname: 'vuln-route-host-orgsel-b',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    if (!deviceB) throw new Error('failed to seed org-B device');

    // Org A: plain high. Org B: KEV critical — a narrowing failure inflates
    // org A's counts with org B's scarier finding.
    const vulnA = await seedCatalogVulnerability({ cveId: 'CVE-2026-94001', severity: 'high', cvssScore: '7.5' });
    const vulnB = await seedCatalogVulnerability({
      cveId: 'CVE-2026-94002',
      severity: 'critical',
      cvssScore: '9.9',
      knownExploited: true,
    });
    await seedDeviceFinding({ orgId: env.organization.id, deviceId: deviceA, vulnerabilityId: vulnA, riskScore: '7.50' });
    await seedDeviceFinding({ orgId: orgB.id, deviceId: deviceB.id, vulnerabilityId: vulnB, riskScore: '9.90' });

    // Baseline (no orgId): the partner caller sees BOTH orgs' findings — proves
    // the narrowed assertions below aren't passing because org B is invisible.
    const allStats = await buildApp().request('/api/v1/vulnerabilities/stats', { headers: authHeaders(env) });
    expect(allStats.status).toBe(200);
    expect(((await allStats.json()) as { totalFindings: number }).totalFindings).toBe(2);

    const q = `?orgId=${env.organization.id}`;

    // GET / — aggregated CVE table narrows to org A.
    const listRes = await buildApp().request(`/api/v1/vulnerabilities${q}`, { headers: authHeaders(env) });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { items: Array<{ cveId: string }> };
    expect(list.items.map((i) => i.cveId)).toEqual(['CVE-2026-94001']);

    // GET /software — work queue narrows to org A's single device.
    const swRes = await buildApp().request(`/api/v1/vulnerabilities/software${q}`, { headers: authHeaders(env) });
    expect(swRes.status).toBe(200);
    const sw = await swRes.json() as { items: Array<{ deviceCount: number; cveIds: string[] }> };
    expect(sw.items.reduce((sum, g) => sum + g.deviceCount, 0)).toBe(1);
    expect(sw.items.some((g) => g.cveIds.includes('CVE-2026-94002'))).toBe(false);

    // GET /stats — stat cards narrow to org A (no KEV/critical bleed-through).
    const statsRes = await buildApp().request(`/api/v1/vulnerabilities/stats${q}`, { headers: authHeaders(env) });
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json() as { totalFindings: number; criticalOpen: number; kevCveCount: number };
    expect(stats.totalFindings).toBe(1);
    expect(stats.criticalOpen).toBe(0);
    expect(stats.kevCveCount).toBe(0);

    // An org outside the partner's accessible set: hard 403, not silent-empty.
    const foreign = await setupTestEnvironment({ scope: 'organization' });
    const denied = await buildApp().request(
      `/api/v1/vulnerabilities/stats?orgId=${foreign.organization.id}`,
      { headers: authHeaders(env) },
    );
    expect(denied.status).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bulk-write isolation + lifecycle against the REAL DB.
  // ──────────────────────────────────────────────────────────────────────────

  // test#3: a cross-org finding id submitted to /bulk/accept-risk is SKIPPED
  // (RLS hides it → not_found) and the row stays untouched in the other org.
  runDb('POST /bulk/accept-risk skips a cross-org finding id and leaves the row untouched', async () => {
    const envA = await setupTestEnvironment({ scope: 'organization' });
    const envB = await setupTestEnvironment({ scope: 'organization' });
    const deviceB = await seedDevice(envB, 'xorg-b');
    const vulnB = await seedCatalogVulnerability({ cveId: 'CVE-2026-93001', severity: 'high', cvssScore: '7.5' });
    const findingB = await seedDeviceFinding({
      orgId: envB.organization.id,
      deviceId: deviceB,
      vulnerabilityId: vulnB,
      status: 'open',
    });

    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const res = await postJson(envA, '/api/v1/vulnerabilities/bulk/accept-risk', {
      deviceVulnerabilityIds: [findingB],
      reason: 'attempted cross-org accept',
      acceptedUntil: future,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; succeeded: number; skipped: Array<{ id: string; reason: string }> };
    expect(body.success).toBe(false);
    expect(body.succeeded).toBe(0);
    expect(body.skipped).toEqual([{ id: findingB, reason: 'not_found' }]);

    // The org-B row is unchanged: still open, no acceptance metadata written.
    const row = await readFinding(findingB);
    expect(row?.status).toBe('open');
    expect(row?.acceptedBy).toBeNull();
    expect(row?.acceptedUntil).toBeNull();
    expect(row?.mitigationNote).toBeNull();
  });

  // test#4: reopen clears every resolution field so the finding is newly-open.
  runDb('POST /:id/reopen clears status + acceptedBy/acceptedUntil/mitigationNote/resolvedAt', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await seedDevice(env, 'reopen');
    const vuln = await seedCatalogVulnerability({ cveId: 'CVE-2026-94001', severity: 'high', cvssScore: '7.5' });
    const finding = await seedDeviceFinding({
      orgId: env.organization.id,
      deviceId,
      vulnerabilityId: vuln,
      status: 'open',
    });

    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const acceptRes = await postJson(env, `/api/v1/vulnerabilities/${finding}/accept-risk`, {
      reason: 'temporary waiver',
      acceptedUntil: future,
    });
    expect(acceptRes.status).toBe(200);

    // Acceptance persisted the full waiver metadata.
    const accepted = await readFinding(finding);
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.acceptedBy).toBe(env.user.id);
    expect(accepted?.acceptedUntil).not.toBeNull();
    expect(accepted?.mitigationNote).toBe('temporary waiver');

    const reopenRes = await postJson(env, `/api/v1/vulnerabilities/${finding}/reopen`, {});
    expect(reopenRes.status).toBe(200);

    // Reopen wiped every resolution field.
    const reopened = await readFinding(finding);
    expect(reopened?.status).toBe('open');
    expect(reopened?.acceptedBy).toBeNull();
    expect(reopened?.acceptedUntil).toBeNull();
    expect(reopened?.mitigationNote).toBeNull();
    expect(reopened?.resolvedAt).toBeNull();
  });
});
