import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

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

function authHeaders(env: TestEnvironment): Record<string, string> {
  return { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' };
}

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

async function seedOpenDeviceVuln(): Promise<{ env: TestEnvironment; dvId: string; userId: string }> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: uniq('wf-agent'),
      hostname: uniq('wf-host'),
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  const [vuln] = await getTestDb()
    .insert(vulnerabilities)
    .values({
      cveId: uniq('CVE-WF'),
      source: 'nvd',
      description: 'workflow test',
      cvssVersion: '3.1',
      cvssScore: '7.5',
      rawPayload: { test: true },
    })
    .returning({ id: vulnerabilities.id });
  const [dv] = await getTestDb()
    .insert(deviceVulnerabilities)
    .values({
      orgId: env.organization.id,
      deviceId: device!.id,
      vulnerabilityId: vuln!.id,
      status: 'open',
      detectedAt: new Date('2026-06-23T12:00:00Z'),
    })
    .returning({ id: deviceVulnerabilities.id });
  return { env, dvId: dv!.id, userId: env.user.id };
}

async function getDeviceVuln(dvId: string) {
  const [row] = await getTestDb()
    .select()
    .from(deviceVulnerabilities)
    .where(eq(deviceVulnerabilities.id, dvId))
    .limit(1);
  if (!row) throw new Error(`device vulnerability ${dvId} not found`);
  return row;
}

describe('vulnerability reopen', () => {
  runDb('reopens a mitigated finding — clears all resolution fields', async () => {
    const { env, dvId } = await seedOpenDeviceVuln();

    // First mitigate it.
    const mitigateRes = await buildApp().request(`/api/v1/vulnerabilities/${dvId}/mitigate`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ note: 'isolated the affected service' }),
    });
    expect(mitigateRes.status).toBe(200);
    const mitigatedRow = await getDeviceVuln(dvId);
    expect(mitigatedRow.status).toBe('mitigated');
    expect(mitigatedRow.resolvedAt).not.toBeNull();

    // Now reopen — no body.
    const reopenRes = await buildApp().request(`/api/v1/vulnerabilities/${dvId}/reopen`, {
      method: 'POST',
      headers: authHeaders(env),
    });
    expect(reopenRes.status).toBe(200);
    expect(await reopenRes.json()).toEqual({ success: true });

    const reopenedRow = await getDeviceVuln(dvId);
    expect(reopenedRow.status).toBe('open');
    expect(reopenedRow.resolvedAt).toBeNull();
    expect(reopenedRow.mitigationNote).toBeNull();
    expect(reopenedRow.acceptedBy).toBeNull();
    expect(reopenedRow.acceptedUntil).toBeNull();
  });

  runDb('reopens an accepted-risk finding — clears all resolution fields', async () => {
    const { env, dvId, userId } = await seedOpenDeviceVuln();

    // First accept-risk.
    await buildApp().request(`/api/v1/vulnerabilities/${dvId}/accept-risk`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ reason: 'compensating control', acceptedUntil: '2030-01-01T00:00:00Z' }),
    });
    const acceptedRow = await getDeviceVuln(dvId);
    expect(acceptedRow.status).toBe('accepted');
    expect(acceptedRow.acceptedBy).toBe(userId);

    // Reopen.
    const reopenRes = await buildApp().request(`/api/v1/vulnerabilities/${dvId}/reopen`, {
      method: 'POST',
      headers: authHeaders(env),
    });
    expect(reopenRes.status).toBe(200);

    const reopenedRow = await getDeviceVuln(dvId);
    expect(reopenedRow.status).toBe('open');
    expect(reopenedRow.acceptedBy).toBeNull();
    expect(reopenedRow.acceptedUntil).toBeNull();
    expect(reopenedRow.mitigationNote).toBeNull();
    expect(reopenedRow.resolvedAt).toBeNull();
  });

  runDb('returns 404 for an unknown finding on reopen', async () => {
    const { env } = await seedOpenDeviceVuln();
    const res = await buildApp().request(
      '/api/v1/vulnerabilities/00000000-0000-0000-0000-000000000000/reopen',
      { method: 'POST', headers: authHeaders(env) },
    );
    expect(res.status).toBe(404);
  });
});

describe('vulnerability accept-risk + mitigate', () => {
  runDb('accepts a risk with reason + future expiry', async () => {
    const { env, dvId, userId } = await seedOpenDeviceVuln();
    const res = await buildApp().request(`/api/v1/vulnerabilities/${dvId}/accept-risk`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ reason: 'compensating control in place', acceptedUntil: '2030-01-01T00:00:00Z' }),
    });
    expect(res.status).toBe(200);
    const row = await getDeviceVuln(dvId);
    expect(row.status).toBe('accepted');
    expect(row.acceptedBy).toBe(userId);
    expect(row.mitigationNote).toBe('compensating control in place');
  });

  runDb('rejects accept-risk with a past expiry', async () => {
    const { env, dvId } = await seedOpenDeviceVuln();
    const res = await buildApp().request(`/api/v1/vulnerabilities/${dvId}/accept-risk`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ reason: 'x', acceptedUntil: '2000-01-01T00:00:00Z' }),
    });
    expect(res.status).toBe(400);
    expect((await getDeviceVuln(dvId)).status).toBe('open');
  });

  runDb('mitigates with a note', async () => {
    const { env, dvId } = await seedOpenDeviceVuln();
    const res = await buildApp().request(`/api/v1/vulnerabilities/${dvId}/mitigate`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ note: 'disabled the vulnerable feature' }),
    });
    expect(res.status).toBe(200);
    const row = await getDeviceVuln(dvId);
    expect(row.status).toBe('mitigated');
    expect(row.mitigationNote).toBe('disabled the vulnerable feature');
    expect(row.resolvedAt).not.toBeNull();
  });

  runDb('returns 404 for an unknown finding', async () => {
    const { env } = await seedOpenDeviceVuln();
    const res = await buildApp().request(
      '/api/v1/vulnerabilities/00000000-0000-0000-0000-000000000000/mitigate',
      {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ note: 'nope' }),
      },
    );
    expect(res.status).toBe(404);
  });
});
