/**
 * Real PostgreSQL/Redis coverage for #7217: a failed Add Device attempt must
 * not leave a live enrollment key, a failed short-link download must not
 * consume a use, and the key list must name each key's site.
 *
 * The routes run with the production auth middleware and the production DB
 * pool (`breeze_app`, forced RLS). Seeds and forensic reads use the privileged
 * test connection. Every failure below is driven by an http PUBLIC_API_URL,
 * which the Windows filename-token installer refuses before any network I/O.
 */
import '../__tests__/integration/setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDb } from '../__tests__/integration/setup';
import {
  createSite,
  setupTestEnvironment,
  type TestEnvironment,
} from '../__tests__/integration/db-utils';
import { enrollmentKeys } from '../db/schema';
import { enrollmentKeyRoutes, publicShortLinkRoutes } from './enrollmentKeys';
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

function app(): Hono {
  const a = new Hono();
  a.route('/enrollment-keys', enrollmentKeyRoutes);
  a.route('/s', publicShortLinkRoutes);
  return a;
}

async function createKey(token: string, siteId: string): Promise<string> {
  const res = await app().request('/enrollment-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Add device installer ${randomUUID()}`, siteId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function keyRow(id: string) {
  const [row] = await getTestDb()
    .select({ id: enrollmentKeys.id, usageCount: enrollmentKeys.usageCount })
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.id, id));
  return row;
}

const HTTP_ONLY_SERVER = 'http://self-hosted.example.com:8080';

describe('#7217 failed Add Device attempts — real PostgreSQL/Redis', () => {
  let savedPublicUrl: string | undefined;

  beforeEach(() => {
    savedPublicUrl = process.env.PUBLIC_API_URL;
    process.env.PUBLIC_API_URL = HTTP_ONLY_SERVER;
  });

  afterEach(() => {
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = savedPublicUrl;
  });

  runDb('discards the key a failed installer build was minted for, and only that key', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const token = await mfaToken(env);

    // 1. Fresh, unused key of the caller's own: discarded.
    const fresh = await createKey(token, env.site.id);
    const failed = await app().request(
      `/enrollment-keys/${fresh}/installer/windows?discardKeyOnFailure=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(failed.status).toBe(400);
    expect(await keyRow(fresh)).toBeUndefined();

    // 2. Same failure without the flag (Settings download of a kept key): kept.
    const kept = await createKey(token, env.site.id);
    const noFlag = await app().request(`/enrollment-keys/${kept}/installer/windows`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(noFlag.status).toBe(400);
    expect(await keyRow(kept)).toBeDefined();

    // 3. A key that has enrolled a device is in service: the flag cannot remove it.
    const used = await createKey(token, env.site.id);
    await getTestDb()
      .update(enrollmentKeys)
      .set({ usageCount: 1, maxUsage: 5 })
      .where(eq(enrollmentKeys.id, used));
    const usedRes = await app().request(
      `/enrollment-keys/${used}/installer/windows?discardKeyOnFailure=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(usedRes.status).toBe(400);
    expect(await keyRow(used)).toBeDefined();

    // 4. Someone else's key (here: no creator): the flag cannot remove it.
    const [foreign] = await getTestDb()
      .insert(enrollmentKeys)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        name: `foreign-${randomUUID()}`,
        key: `foreign-hash-${randomUUID()}`,
        maxUsage: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdBy: null,
      })
      .returning({ id: enrollmentKeys.id });
    const foreignRes = await app().request(
      `/enrollment-keys/${foreign!.id}/installer/windows?discardKeyOnFailure=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(foreignRes.status).toBe(400);
    expect(await keyRow(foreign!.id)).toBeDefined();
  });

  runDb('refuses a Windows link it cannot serve, and discards its parent key', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const token = await mfaToken(env);
    const parent = await createKey(token, env.site.id);

    const res = await app().request(
      `/enrollment-keys/${parent}/installer-link?discardKeyOnFailure=1`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'windows' }),
      },
    );
    expect(res.status).toBe(400);
    expect(await keyRow(parent)).toBeUndefined();
    const children = await getTestDb()
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.orgId, env.organization.id));
    expect(children).toEqual([]);
  });

  runDb('a failed short-link download gives its use back and leaves no download key', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const code = `rf${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const [link] = await getTestDb()
      .insert(enrollmentKeys)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        name: `link-${randomUUID()}`,
        key: `link-hash-${randomUUID()}`,
        maxUsage: 5,
        usageCount: 0,
        expiresAt: new Date(Date.now() + 86_400_000),
        shortCode: code,
        installerPlatform: 'windows',
      })
      .returning({ id: enrollmentKeys.id });

    const res = await app().request(`/s/${code}`);
    expect(res.status).toBe(400);

    expect((await keyRow(link!.id))?.usageCount).toBe(0);
    const downloadKeys = await getTestDb()
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.sourceLinkKeyId, link!.id));
    expect(downloadKeys).toEqual([]);
  });

  runDb('the key list names each key\'s site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'organizations', action: 'read' },
        { resource: 'organizations', action: 'write' },
      ],
    });
    const branch = await createSite({ orgId: env.organization.id, name: `Branch ${randomUUID()}` });
    const token = await mfaToken(env);
    const hqKey = await createKey(token, env.site.id);
    const branchKey = await createKey(token, branch.id);

    const res = await app().request('/enrollment-keys', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; siteName: string | null }> };
    const byId = new Map(body.data.map((row) => [row.id, row.siteName]));
    expect(byId.get(hqKey)).toBe(env.site.name);
    expect(byId.get(branchKey)).toBe(branch.name);
  });
});
