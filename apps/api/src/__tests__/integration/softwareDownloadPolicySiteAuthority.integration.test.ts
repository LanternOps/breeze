import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import { organizationUsers } from '../../db/schema';
import { softwareRoutes } from '../../routes/software';
import { createAccessToken } from '../../services/jwt';
import {
  getEffectiveSoftwareDownloadPolicy,
} from '../../services/softwareDownloadPolicy';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const BASELINE_POLICY = {
  version: 1 as const,
  approvedPrivateOrigins: ['https://baseline.example.internal'],
};

const CHANGED_POLICY = {
  version: 1 as const,
  approvedPrivateOrigins: ['https://changed.example.internal'],
};

function buildApp(): Hono {
  const app = new Hono();
  app.route('/software', softwareRoutes);
  return app;
}

async function mfaToken(env: TestEnvironment): Promise<string> {
  return createAccessToken({
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
  });
}

async function requestPolicy(
  app: Hono,
  token: string,
  method: 'GET' | 'PUT',
  policy = BASELINE_POLICY,
): Promise<Response> {
  return app.request('/software/download-policy', {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'PUT' ? { body: JSON.stringify(policy) } : {}),
  });
}

async function setSiteCeiling(env: TestEnvironment, siteIds: string[] | null): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(
        eq(organizationUsers.userId, env.user.id),
        eq(organizationUsers.orgId, env.organization.id),
      ));
  });
  await clearPermissionCache(env.user.id);
}

async function effectivePolicy(orgId: string, siteId: string) {
  return withSystemDbAccessContext(() => getEffectiveSoftwareDownloadPolicy(orgId, siteId));
}

describe('software download policy organization authority (breeze_app)', () => {
  runDb('site-restricted users cannot read or replace inherited org policy; unrestricted users can update and restore it', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'write' }],
    });
    const secondSite = await createSite({
      orgId: env.organization.id,
      name: 'Download-policy sibling site',
    });
    const token = await mfaToken(env);
    const app = buildApp();

    // Establish a non-empty inherited baseline through the real route and the
    // unprivileged request connection before narrowing the caller.
    const baselineWrite = await requestPolicy(app, token, 'PUT', BASELINE_POLICY);
    expect(baselineWrite.status).toBe(200);
    expect(await baselineWrite.json()).toEqual({ data: BASELINE_POLICY });

    await setSiteCeiling(env, [env.site.id]);

    const deniedRead = await requestPolicy(app, token, 'GET');
    expect(deniedRead.status).toBe(403);
    expect(await deniedRead.json()).toEqual({ error: 'Forbidden' });

    const deniedWrite = await requestPolicy(app, token, 'PUT', CHANGED_POLICY);
    expect(deniedWrite.status).toBe(403);
    expect(await deniedWrite.json()).toEqual({ error: 'Forbidden' });

    // Both the selected site and its hidden sibling still inherit the old org
    // policy: the denied write caused no partial mutation.
    expect(await effectivePolicy(env.organization.id, env.site.id)).toEqual(BASELINE_POLICY);
    expect(await effectivePolicy(env.organization.id, secondSite.id)).toEqual(BASELINE_POLICY);

    await setSiteCeiling(env, null);

    const unrestrictedRead = await requestPolicy(app, token, 'GET');
    expect(unrestrictedRead.status).toBe(200);
    expect(await unrestrictedRead.json()).toEqual({ data: BASELINE_POLICY });

    const changedWrite = await requestPolicy(app, token, 'PUT', CHANGED_POLICY);
    expect(changedWrite.status).toBe(200);
    expect(await effectivePolicy(env.organization.id, env.site.id)).toEqual(CHANGED_POLICY);
    expect(await effectivePolicy(env.organization.id, secondSite.id)).toEqual(CHANGED_POLICY);

    const restoreWrite = await requestPolicy(app, token, 'PUT', BASELINE_POLICY);
    expect(restoreWrite.status).toBe(200);
    expect(await effectivePolicy(env.organization.id, env.site.id)).toEqual(BASELINE_POLICY);
    expect(await effectivePolicy(env.organization.id, secondSite.id)).toEqual(BASELINE_POLICY);
  });
});
