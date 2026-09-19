import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { devices, discoveredAssets, tunnelAllowlists, tunnelSessions } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';

vi.mock('../../routes/agentWs', () => ({
  isAgentConnected: vi.fn(() => true),
  sendCommandToAgent: vi.fn(),
}));
vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  getTrustedClientIp: vi.fn(() => '203.0.113.10'),
}));

import { tunnelRoutes } from '../../routes/tunnels';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * Regression for the prod incident of 2026-09-15 (US, proxy-connect on a
 * discovered printer): the FIRST Connect created the auto-allowlist rule, and
 * every LATER Connect died with a 500. The handler caught the 23505 from the
 * (org, direction, pattern, COALESCE(site)) unique index and re-selected the
 * existing row — but the request runs inside ONE withDbAccessContext
 * transaction, so the caught violation had already aborted it and the
 * re-select failed with 25P02 ("current transaction is aborted"). Same
 * mechanism turns POST /tunnels/allowlist's mapped 409 into a 500 at commit.
 * Only a live-DB test through the real router can see this; the Drizzle-mocked
 * unit suite was green throughout.
 */

function buildApp(): Hono {
  const app = new Hono();
  app.route('/tunnels', tunnelRoutes);
  return app;
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

function post(app: Hono, token: string, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fixture() {
  const env = await setupTestEnvironment({
    scope: 'organization',
    rolePermissions: [
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'execute' },
      { resource: 'remote', action: 'access' },
    ],
  });
  const token = await mintMfaToken(env);
  return { env, token, app: buildApp() };
}

describe('tunnel allowlist duplicate handling inside the request transaction (real PostgreSQL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  runDb('POST /tunnels/allowlist: a duplicate rule returns 409, not 500 (caught 23505 must not abort the request transaction)', async () => {
    const { env, token, app } = await fixture();
    const body = { direction: 'destination', pattern: '10.0.0.9/32:443' };

    const first = await post(app, token, '/tunnels/allowlist', body);
    expect(first.status).toBe(201);

    const second = await post(app, token, '/tunnels/allowlist', body);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: expect.stringMatching(/already exists/i) });

    const rows = await getTestDb().select({ id: tunnelAllowlists.id }).from(tunnelAllowlists)
      .where(and(eq(tunnelAllowlists.orgId, env.organization.id), eq(tunnelAllowlists.pattern, body.pattern)));
    expect(rows).toHaveLength(1);
  });

  runDb('POST /tunnels/proxy-connect: a second Connect to the same asset:port reuses the rule and returns 201 (prod 2026-09-15 repro)', async () => {
    const { env, token, app } = await fixture();
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `proxy-connect-${randomUUID()}`,
      hostname: 'proxy-connect-bridge',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'online',
      enrolledAt: new Date(),
    }).returning();
    if (!device) throw new Error('device fixture insert failed');
    const [asset] = await getTestDb().insert(discoveredAssets).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      ipAddress: '192.168.86.175',
      assetType: 'printer',
      approvalStatus: 'approved',
    }).returning();
    if (!asset) throw new Error('asset fixture insert failed');

    const body = {
      deviceId: device.id,
      discoveredAssetId: asset.id,
      port: 443,
      scheme: 'https',
      skipTlsVerify: true,
    };

    const first = await post(app, token, '/tunnels/proxy-connect', body);
    expect(first.status).toBe(201);
    expect((await first.json()).tunnel).toBeDefined();

    // Second Connect: the rule already exists. Before the fix this was a 500
    // (25P02 on the re-select after the caught unique violation).
    const second = await post(app, token, '/tunnels/proxy-connect', body);
    expect(second.status).toBe(201);
    expect((await second.json()).tunnel).toBeDefined();

    const rules = await getTestDb().select({ id: tunnelAllowlists.id }).from(tunnelAllowlists)
      .where(and(
        eq(tunnelAllowlists.orgId, env.organization.id),
        eq(tunnelAllowlists.pattern, '192.168.86.175/32:443'),
      ));
    expect(rules).toHaveLength(1);

    const sessions = await getTestDb().select({ id: tunnelSessions.id }).from(tunnelSessions)
      .where(and(eq(tunnelSessions.deviceId, device.id), eq(tunnelSessions.type, 'proxy')));
    expect(sessions).toHaveLength(2);
  });
});
