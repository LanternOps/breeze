import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceVulnerabilities,
  softwareProducts,
  softwareVulnerabilities,
  vulnerabilities,
  vulnerabilitySources,
} from '../../db/schema';
import { vulnerabilityRoutes } from '../../routes/vulnerabilities';
import { getTestDb } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/vulnerabilities', vulnerabilityRoutes);
  return app;
}

function authHeaders(env: TestEnvironment) {
  return { Authorization: `Bearer ${env.token}` };
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

async function seedDevice(env: TestEnvironment, suffix: string): Promise<string> {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
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
        }>;
      };

      // Only org A's two CVEs returned
      expect(body.items).toHaveLength(2);

      // Fleet rows have EXACTLY the aggregated shape — no status, no deviceId, no patchAvailable
      const firstItem = body.items[0]!;
      expect(firstItem).toHaveProperty('id');
      expect(firstItem).toHaveProperty('cveId');
      expect(firstItem).toHaveProperty('cvssScore');
      expect(firstItem).toHaveProperty('severity');
      expect(firstItem).toHaveProperty('knownExploited');
      expect(firstItem).toHaveProperty('epssScore');
      expect(firstItem).toHaveProperty('riskScore');
      expect(firstItem).toHaveProperty('deviceCount');
      expect(firstItem).not.toHaveProperty('deviceId');
      expect(firstItem).not.toHaveProperty('patchAvailable');
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
});
