import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { automationPolicies, automationPolicyCompliance, devices, organizationUsers } from '../../db/schema';
import { policyRoutes } from '../../routes/policyManagement';
import { clearPermissionCache } from '../../services/permissions';
import { getTestDb } from './setup';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';

// Real-Postgres proof for #4880: the site axis is app-layer only (RLS does not
// defend it), so a site-restricted caller must not see compliance rows or
// device identities for devices outside their allowlist. The unit suite in
// routes/policyManagement asserts the SQL shape; this asserts the data.
const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/policies', policyRoutes);
  return app;
}

async function get(env: TestEnvironment, path: string) {
  const response = await buildApp().request(path, {
    headers: { Authorization: `Bearer ${env.token}` },
  });
  const text = await response.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function restrictUserToSites(env: TestEnvironment, siteIds: string[]) {
  await withSystemDbAccessContext(async () => {
    await db
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
  });
  await clearPermissionCache(env.user.id);
}

interface Fixture {
  env: TestEnvironment;
  policyId: string;
  inSiteId: string;
  outSiteId: string;
  inDeviceId: string;
  outDeviceId: string;
}

async function seedFixture(): Promise<Fixture> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const outSite = await createSite({ orgId: env.organization.id, name: 'Out-of-scope site' });
  const testDb = getTestDb();
  const suffix = crypto.randomUUID().slice(0, 8);

  const [policy] = await testDb
    .insert(automationPolicies)
    .values({
      orgId: env.organization.id,
      name: `Site scope policy ${suffix}`,
      targets: { type: 'all' },
      rules: [{ type: 'service_running', value: 'spooler' }],
      enforcement: 'monitor',
    })
    .returning({ id: automationPolicies.id });

  const [inDevice, outDevice] = await testDb
    .insert(devices)
    .values([
      {
        orgId: env.organization.id, siteId: env.site.id, agentId: `apc-in-${suffix}`,
        hostname: `in-site-${suffix}`, osType: 'windows', osVersion: '11',
        architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline',
      },
      {
        orgId: env.organization.id, siteId: outSite.id, agentId: `apc-out-${suffix}`,
        hostname: `out-of-site-${suffix}`, osType: 'windows', osVersion: '11',
        architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline',
      },
    ])
    .returning({ id: devices.id });
  if (!policy || !inDevice || !outDevice) throw new Error('failed to seed fixture');

  await testDb.insert(automationPolicyCompliance).values([
    { policyId: policy.id, deviceId: inDevice.id, status: 'non_compliant', details: {}, lastCheckedAt: new Date() },
    { policyId: policy.id, deviceId: outDevice.id, status: 'non_compliant', details: {}, lastCheckedAt: new Date() },
  ]);

  return {
    env, policyId: policy.id, inSiteId: env.site.id, outSiteId: outSite.id,
    inDeviceId: inDevice.id, outDeviceId: outDevice.id,
  };
}

describe('policy compliance site isolation (#4880)', () => {
  runDb('GET /policies/compliance/summary hides out-of-site devices and their counts', async () => {
    const f = await seedFixture();

    const unrestricted = await get(f.env, '/api/v1/policies/compliance/summary');
    expect(unrestricted.status).toBe(200);
    expect(unrestricted.body.overall.total).toBe(2);
    expect(unrestricted.body.nonCompliantDevices.map((d: any) => d.deviceId).sort())
      .toEqual([f.inDeviceId, f.outDeviceId].sort());

    await restrictUserToSites(f.env, [f.inSiteId]);
    const restricted = await get(f.env, '/api/v1/policies/compliance/summary');
    expect(restricted.status).toBe(200);
    expect(restricted.body.overall).toMatchObject({ total: 1, nonCompliant: 1 });
    expect(restricted.body.nonCompliantDevices).toHaveLength(1);
    expect(restricted.body.nonCompliantDevices[0].deviceId).toBe(f.inDeviceId);
    expect(JSON.stringify(restricted.body)).not.toContain(f.outDeviceId);
    expect(JSON.stringify(restricted.body)).not.toContain('out-of-site-');
    const policy = restricted.body.policies.find((p: any) => p.policyId === f.policyId);
    expect(policy.compliance).toMatchObject({ total: 1, nonCompliant: 1 });
    // Policy inventory is intentionally org-wide.
    expect(restricted.body.totalPolicies).toBe(unrestricted.body.totalPolicies);

    await restrictUserToSites(f.env, [f.outSiteId]);
    const other = await get(f.env, '/api/v1/policies/compliance/summary');
    expect(other.body.nonCompliantDevices.map((d: any) => d.deviceId)).toEqual([f.outDeviceId]);

    await restrictUserToSites(f.env, []);
    const none = await get(f.env, '/api/v1/policies/compliance/summary');
    expect(none.status).toBe(200);
    expect(none.body.overall.total).toBe(0);
    expect(none.body.nonCompliantDevices).toEqual([]);
  });

  runDb('GET /policies/compliance/stats narrows the compliance overview', async () => {
    const f = await seedFixture();

    const unrestricted = await get(f.env, '/api/v1/policies/compliance/stats');
    expect(unrestricted.status).toBe(200);
    expect(unrestricted.body.data.complianceOverview.non_compliant).toBe(2);

    await restrictUserToSites(f.env, [f.inSiteId]);
    const restricted = await get(f.env, '/api/v1/policies/compliance/stats');
    expect(restricted.status).toBe(200);
    expect(restricted.body.data.complianceOverview.non_compliant).toBe(1);
    expect(restricted.body.data.totalPolicies).toBe(unrestricted.body.data.totalPolicies);

    await restrictUserToSites(f.env, []);
    const none = await get(f.env, '/api/v1/policies/compliance/stats');
    expect(none.body.data.complianceOverview).toEqual({ compliant: 0, non_compliant: 0, pending: 0 });
  });

  runDb('GET /policies and GET /policies/:id narrow embedded compliance counts', async () => {
    const f = await seedFixture();

    await restrictUserToSites(f.env, [f.inSiteId]);
    const list = await get(f.env, '/api/v1/policies');
    expect(list.status).toBe(200);
    const row = list.body.data.find((p: any) => p.id === f.policyId);
    expect(row).toBeDefined();
    expect(row.compliance).toMatchObject({ total: 1, nonCompliant: 1 });

    const single = await get(f.env, `/api/v1/policies/${f.policyId}`);
    expect(single.status).toBe(200);
    expect(single.body.compliance).toMatchObject({ total: 1, nonCompliant: 1 });

    await restrictUserToSites(f.env, []);
    const noneList = await get(f.env, '/api/v1/policies');
    expect(noneList.body.data.find((p: any) => p.id === f.policyId).compliance.total).toBe(0);
    const noneSingle = await get(f.env, `/api/v1/policies/${f.policyId}`);
    expect(noneSingle.body.compliance.total).toBe(0);
  });

  runDb('denies a role without devices:read', async () => {
    const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: [] });
    for (const path of ['/compliance/summary', '/compliance/stats', '']) {
      const res = await get(env, `/api/v1/policies${path}`);
      expect(res.status, path).toBe(403);
    }
  });
});
