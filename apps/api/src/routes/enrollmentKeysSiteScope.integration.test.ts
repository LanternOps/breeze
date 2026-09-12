/**
 * Real PostgreSQL/Redis coverage for explicit-site enrollment-key creation.
 *
 * The route runs with the production auth middleware and the production DB
 * pool (`breeze_app`). Seeds and forensic assertions use the privileged test
 * connection, while every request is subject to forced RLS and the live
 * organization membership's site_ids ceiling.
 */
import '../__tests__/integration/setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { getTestDb } from '../__tests__/integration/setup';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
  type TestEnvironment,
} from '../__tests__/integration/db-utils';
import { auditLogs, devices, enrollmentKeys, organizationUsers } from '../db/schema';
import { enrollmentRoutes } from './agents/enrollment';
import { enrollmentKeyRoutes } from './enrollmentKeys';
import { clearPermissionCache } from '../services/permissions';
import { createAccessToken, type TokenPayload } from '../services/jwt';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function mfaToken(env: TestEnvironment): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function keyApp(): Hono {
  const app = new Hono();
  app.route('/enrollment-keys', enrollmentKeyRoutes);
  return app;
}

function agentApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

async function setSiteCeiling(env: TestEnvironment, siteIds: string[] | null): Promise<void> {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  await clearPermissionCache(env.user.id);
}

async function createKey(token: string, name: string, siteId: string): Promise<Response> {
  return keyApp().request('/enrollment-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, siteId, maxUsage: 1, ttlMinutes: 60 }),
  });
}

async function assertNoKeyOrAudit(name: string, actorId: string): Promise<void> {
  // Yield once so a mistakenly invoked fire-and-forget audit write can settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const database = getTestDb();
  const keyRows = await database
    .select({ id: enrollmentKeys.id })
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.name, name));
  const auditRows = await database
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.actorId, actorId),
      eq(auditLogs.action, 'enrollment_key.create'),
      eq(auditLogs.resourceName, name),
    ));
  expect(keyRows).toEqual([]);
  expect(auditRows).toEqual([]);
}

describe('POST /enrollment-keys explicit site scope — real PostgreSQL/Redis', () => {
  runDb('allows only current authorized sites and denies opaque without key or audit side effects', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'hidden site' });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'foreign site' });
    const unknownSiteId = randomUUID();
    const token = await mfaToken(env);

    await setSiteCeiling(env, [env.site.id]);
    const allowedName = `allowed-${randomUUID()}`;
    const allowedResponse = await createKey(token, allowedName, env.site.id);
    expect(allowedResponse.status).toBe(201);
    const allowed = await allowedResponse.json() as { key: string; siteId: string };
    expect(allowed.siteId).toBe(env.site.id);
    expect(allowed.key).toMatch(/^[a-f0-9]{64}$/);

    // Positive source-to-sink control: the allowed raw key really enrolls a
    // synthetic endpoint and returns the three distinct credential channels.
    const enrollResponse = await agentApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentKey: allowed.key,
        hostname: `site-enrollment-${randomUUID()}`,
        osType: 'linux',
        osVersion: 'synthetic',
        architecture: 'amd64',
        agentVersion: '0.0.0-test',
      }),
    });
    expect(enrollResponse.status).toBe(201);
    const enrolled = await enrollResponse.json() as {
      deviceId: string;
      siteId: string;
      authToken: string;
      watchdogAuthToken: string;
      helperAuthToken: string;
    };
    expect(enrolled.siteId).toBe(env.site.id);
    expect(enrolled.authToken).toBeTruthy();
    expect(enrolled.watchdogAuthToken).toBeTruthy();
    expect(enrolled.helperAuthToken).toBeTruthy();
    const [device] = await getTestDb()
      .select({ siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, enrolled.deviceId));
    expect(device?.siteId).toBe(env.site.id);

    const deniedCases: Array<{ name: string; ceiling: string[]; siteId: string }> = [
      { name: `hidden-${randomUUID()}`, ceiling: [env.site.id], siteId: hiddenSite.id },
      { name: `empty-${randomUUID()}`, ceiling: [], siteId: hiddenSite.id },
      // Stale/malformed membership rows are deliberately included to prove
      // same-org validation cannot become an existence oracle.
      { name: `foreign-${randomUUID()}`, ceiling: [foreignSite.id], siteId: foreignSite.id },
      { name: `unknown-${randomUUID()}`, ceiling: [unknownSiteId], siteId: unknownSiteId },
    ];

    for (const denied of deniedCases) {
      await setSiteCeiling(env, denied.ceiling);
      const response = await createKey(token, denied.name, denied.siteId);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Access to this site denied' });
      await assertNoKeyOrAudit(denied.name, env.user.id);
    }

    // Null is the established unrestricted sentinel and remains compatible.
    await setSiteCeiling(env, null);
    const unrestrictedResponse = await createKey(
      token,
      `unrestricted-${randomUUID()}`,
      hiddenSite.id,
    );
    expect(unrestrictedResponse.status).toBe(201);
  });
});
