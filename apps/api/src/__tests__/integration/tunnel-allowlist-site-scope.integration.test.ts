import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createSite, setupTestEnvironment } from './db-utils';
import { organizationUsers, tunnelAllowlists } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { tunnelRoutes } from '../../routes/tunnels';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/tunnels', tunnelRoutes);
  return app;
}

async function restrictedFixture() {
  const env = await setupTestEnvironment({
    scope: 'organization',
    rolePermissions: [
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'execute' },
    ],
  });
  const hiddenSite = await createSite({ orgId: env.organization.id });
  await getTestDb().update(organizationUsers)
    .set({ siteIds: [env.site.id] })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  const token = await mintMfaToken(env);
  return { env, hiddenSite, token };
}

async function mintMfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>) {
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

function request(app: Hono, token: string, path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('tunnel allowlist site authority (real PostgreSQL, breeze_app route)', () => {
  runDb('unrestricted caller retains authority to create an org-wide rule', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const token = await mintMfaToken(env);
    const app = buildApp();

    const response = await request(app, token, '/tunnels/allowlist', 'POST', {
      direction: 'destination',
      pattern: '10.0.0.9/32:443',
    });

    expect(response.status).toBe(201);
    const [row] = await getTestDb().select({ siteId: tunnelAllowlists.siteId })
      .from(tunnelAllowlists)
      .where(eq(tunnelAllowlists.orgId, env.organization.id));
    expect(row).toEqual({ siteId: null });
  });

  runDb('restricted caller can create only a rule for an allowed site', async () => {
    const { env, hiddenSite, token } = await restrictedFixture();
    const app = buildApp();

    const global = await request(app, token, '/tunnels/allowlist', 'POST', {
      direction: 'destination',
      pattern: '10.0.0.1/32:443',
    });
    expect(global.status).toBe(403);

    const hidden = await request(app, token, '/tunnels/allowlist', 'POST', {
      direction: 'destination',
      pattern: '10.0.0.2/32:443',
      siteId: hiddenSite.id,
    });
    expect(hidden.status).toBe(403);

    const allowed = await request(app, token, '/tunnels/allowlist', 'POST', {
      direction: 'destination',
      pattern: '10.0.0.3/32:443',
      siteId: env.site.id,
    });
    expect(allowed.status).toBe(201);

    const rows = await getTestDb().select({
      pattern: tunnelAllowlists.pattern,
      siteId: tunnelAllowlists.siteId,
    }).from(tunnelAllowlists).where(eq(tunnelAllowlists.orgId, env.organization.id));
    expect(rows).toEqual([{ pattern: '10.0.0.3/32:443', siteId: env.site.id }]);
  });

  runDb('restricted caller cannot mutate global or hidden-site rules', async () => {
    const { env, hiddenSite, token } = await restrictedFixture();
    const app = buildApp();
    const [globalRule, hiddenRule, allowedRule] = await getTestDb().insert(tunnelAllowlists).values([
      {
        orgId: env.organization.id,
        siteId: null,
        direction: 'destination',
        pattern: '10.0.1.1/32:443',
        createdBy: env.user.id,
      },
      {
        orgId: env.organization.id,
        siteId: hiddenSite.id,
        direction: 'destination',
        pattern: '10.0.1.2/32:443',
        createdBy: env.user.id,
      },
      {
        orgId: env.organization.id,
        siteId: env.site.id,
        direction: 'destination',
        pattern: '10.0.1.3/32:443',
        createdBy: env.user.id,
      },
    ]).returning();
    if (!globalRule || !hiddenRule || !allowedRule) throw new Error('allowlist fixture insert failed');

    const globalUpdate = await request(app, token, `/tunnels/allowlist/${globalRule.id}`, 'PUT', { enabled: false });
    expect(globalUpdate.status).toBe(403);
    const hiddenDelete = await request(app, token, `/tunnels/allowlist/${hiddenRule.id}`, 'DELETE');
    expect(hiddenDelete.status).toBe(403);

    const allowedUpdate = await request(app, token, `/tunnels/allowlist/${allowedRule.id}`, 'PUT', { enabled: false });
    expect(allowedUpdate.status).toBe(200);
    const allowedDelete = await request(app, token, `/tunnels/allowlist/${allowedRule.id}`, 'DELETE');
    expect(allowedDelete.status).toBe(200);

    const remaining = await getTestDb().select({
      id: tunnelAllowlists.id,
      enabled: tunnelAllowlists.enabled,
    }).from(tunnelAllowlists).where(eq(tunnelAllowlists.orgId, env.organization.id));
    expect(remaining).toEqual(expect.arrayContaining([
      { id: globalRule.id, enabled: true },
      { id: hiddenRule.id, enabled: true },
    ]));
    expect(remaining).toHaveLength(2);
  });

  runDb('caller cannot mutate a foreign-organization rule', async () => {
    const allowed = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const foreign = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(allowed);
    const [foreignRule] = await getTestDb().insert(tunnelAllowlists).values({
      orgId: foreign.organization.id,
      siteId: foreign.site.id,
      direction: 'destination',
      pattern: '10.0.2.1/32:443',
      createdBy: foreign.user.id,
    }).returning();
    if (!foreignRule) throw new Error('foreign allowlist fixture insert failed');

    const response = await request(
      buildApp(),
      token,
      `/tunnels/allowlist/${foreignRule.id}`,
      'PUT',
      { enabled: false },
    );

    expect(response.status).toBe(404);
    const [unchanged] = await getTestDb().select({ enabled: tunnelAllowlists.enabled })
      .from(tunnelAllowlists)
      .where(eq(tunnelAllowlists.id, foreignRule.id));
    expect(unchanged).toEqual({ enabled: true });
  });
});
