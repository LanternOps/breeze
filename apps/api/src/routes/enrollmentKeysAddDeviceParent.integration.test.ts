/**
 * Real PostgreSQL/Redis coverage for #7345: Add Device (Download Installer /
 * Generate Link) reuses one parent enrollment key per (org, site, creator)
 * instead of minting a new parent row on every click.
 *
 * The routes run with the production auth middleware and the production DB
 * pool (`breeze_app`, forced RLS). Seeds and forensic reads use the privileged
 * test connection. The reuse predicate lives in SQL, so only a real database
 * can show that an expired / used / foreign / other-site key is NOT reused.
 */
import '../__tests__/integration/setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDb } from '../__tests__/integration/setup';
import {
  assignUserToOrganization,
  createSite,
  createUser,
  setupTestEnvironment,
  type TestEnvironment,
} from '../__tests__/integration/db-utils';
import { enrollmentKeys, installerBootstrapTokens, organizationUsers } from '../db/schema';
import { enrollmentKeyRoutes } from './enrollmentKeys';
import { createAccessToken, type TokenPayload } from '../services/jwt';
import { clearPermissionCache } from '../services/permissions';
import { generateBootstrapToken } from '../services/installerBootstrapToken';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function mfaToken(
  env: TestEnvironment & { scope?: string },
  userId: string = env.user.id,
  email: string = env.user.email,
): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: userId,
    email,
    roleId: env.role.id,
    orgId: env.scope === 'partner' ? null : env.organization.id,
    partnerId: env.partner.id,
    scope: env.scope === 'partner' ? 'partner' : 'organization',
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

type ParentResponse = {
  id: string;
  name: string;
  siteId: string;
  expiresAt: string;
  reused: boolean;
  key?: unknown;
};

async function addDeviceParent(
  token: string,
  siteId: string,
  orgId?: string,
): Promise<{ status: number; body: ParentResponse }> {
  const res = await app().request('/enrollment-keys/add-device-parent', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, orgId }),
  });
  return { status: res.status, body: (await res.json()) as ParentResponse };
}

async function keysForOrg(orgId: string) {
  return getTestDb()
    .select({ id: enrollmentKeys.id })
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.orgId, orgId));
}

const HTTP_ONLY_SERVER = 'http://self-hosted.example.com:8080';

describe('#7345 Add Device parent key reuse — real PostgreSQL/Redis', () => {
  let savedPublicUrl: string | undefined;

  beforeEach(() => {
    savedPublicUrl = process.env.PUBLIC_API_URL;
    process.env.PUBLIC_API_URL = HTTP_ONLY_SERVER;
  });

  afterEach(() => {
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = savedPublicUrl;
  });

  runDb('repeat requests for the same site reuse one parent and never return its raw key', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const token = await mfaToken(env);

    const first = await addDeviceParent(token, env.site.id);
    expect(first.status).toBe(201);
    expect(first.body.reused).toBe(false);
    expect(first.body.siteId).toBe(env.site.id);
    expect(first.body).not.toHaveProperty('key');

    const second = await addDeviceParent(token, env.site.id);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).not.toHaveProperty('key');

    expect(await keysForOrg(env.organization.id)).toHaveLength(1);

    const [row] = await getTestDb()
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, first.body.id));
    expect(row).toMatchObject({
      siteId: env.site.id,
      createdBy: env.user.id,
      maxUsage: 1,
      usageCount: 0,
      shortCode: null,
      installerPlatform: null,
    });
  });

  runDb('an expired, nearly expired, or used parent is not reused — a new one is minted', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const token = await mfaToken(env);

    const original = await addDeviceParent(token, env.site.id);
    expect(original.status).toBe(201);

    // Expired.
    await getTestDb()
      .update(enrollmentKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(enrollmentKeys.id, original.body.id));
    const afterExpired = await addDeviceParent(token, env.site.id);
    expect(afterExpired.status).toBe(201);
    expect(afterExpired.body.id).not.toBe(original.body.id);

    // Too close to expiry to build an installer from.
    await getTestDb()
      .update(enrollmentKeys)
      .set({ expiresAt: new Date(Date.now() + 30_000) })
      .where(eq(enrollmentKeys.id, afterExpired.body.id));
    const afterNearExpiry = await addDeviceParent(token, env.site.id);
    expect(afterNearExpiry.status).toBe(201);
    expect(afterNearExpiry.body.id).not.toBe(afterExpired.body.id);

    // Exhausted: its single use was spent enrolling a device directly.
    await getTestDb()
      .update(enrollmentKeys)
      .set({ usageCount: 1 })
      .where(eq(enrollmentKeys.id, afterNearExpiry.body.id));
    const afterUsed = await addDeviceParent(token, env.site.id);
    expect(afterUsed.status).toBe(201);
    expect(afterUsed.body.id).not.toBe(afterNearExpiry.body.id);

    // The fresh one is reused again.
    const again = await addDeviceParent(token, env.site.id);
    expect(again.body.reused).toBe(true);
    expect(again.body.id).toBe(afterUsed.body.id);
  });

  runDb('a different site gets a different parent; another user never reuses mine', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const otherSite = await createSite({ orgId: env.organization.id, name: `branch ${randomUUID()}` });
    const token = await mfaToken(env);

    const hq = await addDeviceParent(token, env.site.id);
    const branch = await addDeviceParent(token, otherSite.id);
    expect(branch.status).toBe(201);
    expect(branch.body.id).not.toBe(hq.body.id);
    expect(branch.body.siteId).toBe(otherSite.id);

    // Same site again → still the HQ parent.
    expect((await addDeviceParent(token, env.site.id)).body.id).toBe(hq.body.id);

    // A second user in the same org, same site, gets their own parent.
    const colleague = await createUser({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      email: `colleague-${randomUUID()}@example.com`,
    });
    await assignUserToOrganization(colleague.id, env.organization.id, env.role.id);
    const colleagueToken = await mfaToken(env, colleague.id, colleague.email);
    const theirs = await addDeviceParent(colleagueToken, env.site.id);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(hq.body.id);
  });

  runDb('a key that only looks similar (manual key, link row, other name) is never reused', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const token = await mfaToken(env);

    // A key the same user created by hand in Settings for the same site.
    const manual = await app().request('/enrollment-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Front desk PCs', siteId: env.site.id }),
    });
    expect(manual.status).toBe(201);
    const manualId = ((await manual.json()) as { id: string }).id;

    const parent = await addDeviceParent(token, env.site.id);
    expect(parent.status).toBe(201);
    expect(parent.body.id).not.toBe(manualId);
  });

  runDb('honours the caller\'s site ceiling', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const hidden = await createSite({ orgId: env.organization.id, name: `hidden ${randomUUID()}` });
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(and(
        eq(organizationUsers.userId, env.user.id),
        eq(organizationUsers.orgId, env.organization.id),
      ));
    await clearPermissionCache(env.user.id);
    const token = await mfaToken(env);

    const denied = await addDeviceParent(token, hidden.id);
    expect(denied.status).toBe(403);
    expect(await keysForOrg(env.organization.id)).toHaveLength(0);
  });

  runDb('a failed, flagged attempt on a reused parent keeps the parent and its earlier installers', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const token = await mfaToken(env);
    const parent = await addDeviceParent(token, env.site.id);

    // An installer downloaded earlier from this parent.
    const [earlier] = await getTestDb()
      .insert(installerBootstrapTokens)
      .values({
        token: generateBootstrapToken(),
        orgId: env.organization.id,
        parentEnrollmentKeyId: parent.body.id,
        siteId: env.site.id,
        maxUsage: 1,
        usageKind: 'capacity',
        createdBy: env.user.id,
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
        installerPlatform: 'windows',
      })
      .returning({ id: installerBootstrapTokens.id });

    // A later attempt fails (http-only server) — even a client that wrongly
    // sends the discard flag must not take the shared parent down with it.
    const failed = await app().request(
      `/enrollment-keys/${parent.body.id}/installer/windows?discardKeyOnFailure=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(failed.status).toBe(400);

    const [kept] = await getTestDb()
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, parent.body.id));
    expect(kept).toBeDefined();
    const [token1] = await getTestDb()
      .select({ id: installerBootstrapTokens.id })
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.id, earlier!.id));
    expect(token1).toBeDefined();
  });
});
