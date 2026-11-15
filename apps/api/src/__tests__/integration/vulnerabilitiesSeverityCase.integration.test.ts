import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import { devices, deviceVulnerabilities, vulnerabilities } from '../../db/schema';
import { vulnerabilityRoutes } from '../../routes/vulnerabilities';
import { getTestDb } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';

/**
 * #11902 — feeds store severity in their own casing (NVD 'CRITICAL', MSRC
 * 'Critical'). The list filter lowercased the query and compared exactly, so a
 * `severity=critical` request missed every feed-backed row while the summary
 * (which lowercases in SQL) counted them.
 */

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function get<T>(env: TestEnvironment, path: string): Promise<{ status: number; body: T }> {
  const app = new Hono();
  app.route('/api/v1/vulnerabilities', vulnerabilityRoutes);
  const res = await app.request(`/api/v1/vulnerabilities${path}`, {
    headers: { Authorization: `Bearer ${env.token}` },
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    await db.delete(deviceVulnerabilities);
    await db.delete(vulnerabilities);
  });
});

describe('vulnerability severity filter is case-insensitive (#11902)', () => {
  runDb('severity=critical returns stored CRITICAL / Critical rows (and high stays separate)', async () => {
    const env = await setupTestEnvironment();
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `sev-case-${Date.now()}`,
        hostname: 'sev-case-01',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });

    const stored: Array<[string, string]> = [
      ['CVE-2026-91001', 'CRITICAL'], // NVD casing
      ['CVE-2026-91002', 'Critical'], // MSRC casing
      ['CVE-2026-91003', 'critical'],
      ['CVE-2026-91004', 'HIGH'],
    ];
    for (const [cveId, severity] of stored) {
      const [v] = await getTestDb()
        .insert(vulnerabilities)
        .values({ cveId, source: 'nvd', description: cveId, severity, cvssVersion: '3.1', cvssScore: '9.8', rawPayload: { test: true } })
        .returning({ id: vulnerabilities.id });
      await getTestDb().insert(deviceVulnerabilities).values({
        orgId: env.organization.id,
        deviceId: device!.id,
        vulnerabilityId: v!.id,
        status: 'open',
        riskScore: '9.00',
        detectedAt: new Date('2026-06-23T12:00:00Z'),
      });
    }

    const list = await get<{ items: Array<{ cveId: string }> }>(env, '?severity=critical&status=open');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i) => i.cveId).sort()).toEqual(['CVE-2026-91001', 'CVE-2026-91002', 'CVE-2026-91003']);

    const high = await get<{ items: Array<{ cveId: string }> }>(env, '?severity=high&status=open');
    expect(high.body.items.map((i) => i.cveId)).toEqual(['CVE-2026-91004']);
  });
});
