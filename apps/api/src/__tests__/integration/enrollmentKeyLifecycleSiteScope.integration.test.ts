/**
 * Real PostgreSQL/Redis coverage: every enrollment-key route that takes a key
 * id answers a key in a site the caller cannot see exactly as it answers a key
 * that does not exist, and leaves that key untouched. Keys in the caller's own
 * site keep their normal behaviour.
 *
 * Routes run with the production auth middleware and the production DB pool
 * (`breeze_app`, forced RLS). Seeds and forensic reads use the privileged test
 * connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDb } from './setup';
import {
  createSite,
  setupTestEnvironment,
  type TestEnvironment,
} from './db-utils';
import {
  enrollmentKeys,
  installerBootstrapTokens,
  organizationUsers,
} from '../../db/schema';
import { enrollmentKeyRoutes } from '../../routes/enrollmentKeys';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const NOT_FOUND = { error: 'Enrollment key not found' };
// The Windows installer refuses an http server URL before any network I/O,
// so an in-scope installer request ends in a deterministic 400.
const HTTP_ONLY_SERVER = 'http://self-hosted.example.com:8080';

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

function app(): Hono {
  const a = new Hono();
  a.route('/enrollment-keys', enrollmentKeyRoutes);
  return a;
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

async function seedKey(
  env: TestEnvironment,
  siteId: string,
): Promise<{ id: string; key: string; name: string }> {
  const [row] = await getTestDb()
    .insert(enrollmentKeys)
    .values({
      orgId: env.organization.id,
      siteId,
      name: `lifecycle-${randomUUID()}`,
      key: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      maxUsage: 5,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      createdBy: env.user.id,
    })
    .returning({ id: enrollmentKeys.id, key: enrollmentKeys.key, name: enrollmentKeys.name });
  return row!;
}

describe('enrollment-key lifecycle routes, hidden-site keys — real PostgreSQL/Redis', () => {
  let savedPublicUrl: string | undefined;

  beforeEach(() => {
    savedPublicUrl = process.env.PUBLIC_API_URL;
    process.env.PUBLIC_API_URL = HTTP_ONLY_SERVER;
  });

  afterEach(() => {
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = savedPublicUrl;
  });

  runDb('answers a hidden-site key like a missing one and leaves it untouched; in-site keys are unchanged', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'organizations', action: 'read' },
        { resource: 'organizations', action: 'write' },
      ],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: `hidden ${randomUUID()}` });
    const hidden = await seedKey(env, hiddenSite.id);
    const toRotate = await seedKey(env, env.site.id);
    const toDelete = await seedKey(env, env.site.id);
    const forToken = await seedKey(env, env.site.id);
    const token = await mfaToken(env);
    await setSiteCeiling(env, [env.site.id]);

    const call = (path: string, method: string, body?: unknown) => app().request(
      `/enrollment-keys/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );

    const lifecycle: Array<[string, (id: string) => Response | Promise<Response>]> = [
      ['rotate', (id) => call(`${id}/rotate`, 'POST', {})],
      ['delete', (id) => call(id, 'DELETE')],
      ['installer', (id) => call(`${id}/installer/windows`, 'GET')],
      ['bootstrap-token', (id) => call(`${id}/bootstrap-token`, 'POST', { maxUsage: 1 })],
      ['installer-link', (id) => call(`${id}/installer-link`, 'POST', { platform: 'windows' })],
    ];

    for (const [name, request] of lifecycle) {
      const res = await request(hidden.id);
      expect(res.status, name).toBe(404);
      await expect(res.json(), name).resolves.toEqual(NOT_FOUND);
    }

    // Identical to a key id that does not exist at all.
    const missing = await call(`${randomUUID()}/rotate`, 'POST', {});
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual(NOT_FOUND);

    // download-handle already answered opaquely; it still does.
    const hiddenHandle = await call(`${hidden.id}/download-handle`, 'POST', { rawToken: 'x' });
    expect(hiddenHandle.status).toBe(404);
    await expect(hiddenHandle.json()).resolves.toEqual({ error: 'Not found' });

    // The hidden key was neither rotated nor deleted, and nothing was derived from it.
    const [hiddenAfter] = await getTestDb()
      .select({ key: enrollmentKeys.key })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, hidden.id));
    expect(hiddenAfter?.key).toBe(hidden.key);
    const derivedTokens = await getTestDb()
      .select({ id: installerBootstrapTokens.id })
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.parentEnrollmentKeyId, hidden.id));
    expect(derivedTokens).toEqual([]);
    // Installer children are named after their parent.
    const childKeys = await getTestDb()
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(like(enrollmentKeys.name, `${hidden.name} (%`));
    expect(childKeys).toEqual([]);

    // Keys in the caller's own site behave as before.
    const rotated = await call(`${toRotate.id}/rotate`, 'POST', {});
    expect(rotated.status).toBe(200);
    const [rotatedAfter] = await getTestDb()
      .select({ key: enrollmentKeys.key })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, toRotate.id));
    expect(rotatedAfter?.key).not.toBe(toRotate.key);

    const deleted = await call(toDelete.id, 'DELETE');
    expect(deleted.status).toBe(200);
    const [deletedAfter] = await getTestDb()
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, toDelete.id));
    expect(deletedAfter).toBeUndefined();

    const issued = await call(`${forToken.id}/bootstrap-token`, 'POST', { maxUsage: 1 });
    expect(issued.status).toBe(200);
    expect((await issued.json() as { token?: string }).token).toEqual(expect.any(String));

    const installer = await call(`${forToken.id}/installer/windows`, 'GET');
    expect(installer.status).toBe(400);

    const handle = await call(`${forToken.id}/download-handle`, 'POST', { rawToken: 'not-the-key' });
    expect(handle.status).toBe(400);
    await expect(handle.json()).resolves.toEqual({ error: 'Invalid token' });
  });
});
