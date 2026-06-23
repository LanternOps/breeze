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
      patchAvailable: true,
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
  runDb('GET /api/v1/vulnerabilities returns caller-scope open rows sorted by CVSS desc', async () => {
    const envA = await setupTestEnvironment({ scope: 'organization' });
    const envB = await setupTestEnvironment({ scope: 'organization' });
    const deviceA = await seedDevice(envA, 'a');
    const deviceB = await seedDevice(envB, 'b');

    const low = await seedCatalogVulnerability({
      cveId: 'CVE-2026-10001',
      severity: 'high',
      cvssScore: '7.5',
    });
    const critical = await seedCatalogVulnerability({
      cveId: 'CVE-2026-10002',
      severity: 'critical',
      cvssScore: '9.8',
      knownExploited: true,
    });
    const patched = await seedCatalogVulnerability({
      cveId: 'CVE-2026-10003',
      severity: 'critical',
      cvssScore: '10.0',
    });
    const otherOrg = await seedCatalogVulnerability({
      cveId: 'CVE-2026-10004',
      severity: 'critical',
      cvssScore: '9.9',
    });

    await seedDeviceFinding({
      orgId: envA.organization.id,
      deviceId: deviceA,
      vulnerabilityId: low,
      riskScore: '7.50',
    });
    await seedDeviceFinding({
      orgId: envA.organization.id,
      deviceId: deviceA,
      vulnerabilityId: critical,
      riskScore: '9.80',
    });
    await seedDeviceFinding({
      orgId: envA.organization.id,
      deviceId: deviceA,
      vulnerabilityId: patched,
      status: 'patched',
      riskScore: '10.00',
    });
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
    const body = await res.json() as { items: Array<{ cveId: string; cvssScore: number; status: string }> };
    expect(body.items.map((item) => item.cveId)).toEqual(['CVE-2026-10002', 'CVE-2026-10001']);
    expect(body.items[0]!.cvssScore).toBeGreaterThanOrEqual(body.items[1]!.cvssScore);
    expect(body.items.every((item) => item.status === 'open')).toBe(true);
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
    const body = await res.json() as { items: Array<{ cveId: string; severity: string }> };
    expect(body.items).toEqual([
      expect.objectContaining({ cveId: 'CVE-2026-20001', severity: 'critical' }),
    ]);
  });

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
    const body = await res.json() as { items: Array<{ cveId: string; deviceId: string; status: string }> };
    expect(body.items).toEqual([
      expect.objectContaining({
        cveId: 'CVE-2026-30001',
        deviceId: targetDeviceId,
        status: 'open',
      }),
    ]);
  });
});
