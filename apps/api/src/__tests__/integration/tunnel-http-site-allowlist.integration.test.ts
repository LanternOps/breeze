import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createSite, setupTestEnvironment } from './db-utils';
import { devices, tunnelAllowlists, tunnelSessions } from '../../db/schema';

const { consumeWsTicketMock, sendCommandMock } = vi.hoisted(() => ({
  consumeWsTicketMock: vi.fn(),
  sendCommandMock: vi.fn(),
}));

vi.mock('../../services/remoteSessionAuth', () => ({
  consumeWsTicket: consumeWsTicketMock,
}));
vi.mock('../../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: sendCommandMock,
}));
vi.mock('../../routes/agentWs', () => ({
  isAgentConnected: vi.fn(() => true),
}));
vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.10'),
}));

import { tunnelHttpRoutes } from '../../routes/tunnelHttp';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/tunnel-http', tunnelHttpRoutes);
  return app;
}

describe('tunnel HTTP effective-site allowlist delivery (real PostgreSQL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        status: 200,
        headers: { 'content-type': ['text/plain'] },
        bodyB64: Buffer.from('ok').toString('base64'),
      }),
    });
  });

  runDb('delivers global and bridge-site rules but excludes a sibling-site rule', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const siblingSite = await createSite({ orgId: env.organization.id });
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `tunnel-http-${randomUUID()}`,
      hostname: 'tunnel-http-bridge',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'online',
      enrolledAt: new Date(),
    }).returning();
    if (!device) throw new Error('device fixture insert failed');
    const [session] = await getTestDb().insert(tunnelSessions).values({
      orgId: env.organization.id,
      userId: env.user.id,
      deviceId: device.id,
      type: 'proxy',
      status: 'active',
      targetHost: '10.0.0.50',
      targetPort: 443,
      scheme: 'https',
      skipTlsVerify: false,
    }).returning();
    if (!session) throw new Error('tunnel session fixture insert failed');
    await getTestDb().insert(tunnelAllowlists).values([
      {
        orgId: env.organization.id,
        siteId: null,
        direction: 'destination',
        pattern: '10.0.0.0/24:443',
        createdBy: env.user.id,
      },
      {
        orgId: env.organization.id,
        siteId: env.site.id,
        direction: 'destination',
        pattern: '10.0.0.50/32:443',
        createdBy: env.user.id,
      },
      {
        orgId: env.organization.id,
        siteId: siblingSite.id,
        direction: 'destination',
        pattern: '10.0.0.99/32:443',
        createdBy: env.user.id,
      },
    ]);

    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: session.id,
      sessionType: 'tunnel-http',
      userId: env.user.id,
      expiresAt: Date.now() + 60_000,
    });
    const base = `/api/v1/tunnel-http/${session.id}/`;
    const ticketResponse = await buildApp().request(`${base}?__bzt=synthetic-ticket`);
    expect(ticketResponse.status).toBe(302);
    const cookie = (ticketResponse.headers.get('set-cookie') ?? '').match(/(bz_tunnel_[^=]+=[^;]+)/)?.[1];
    expect(cookie).toBeTruthy();

    const response = await buildApp().request(base, { headers: { cookie: cookie! } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    const command = sendCommandMock.mock.calls[0]?.[1];
    expect(command?.payload.allowlistRules).toEqual([
      '10.0.0.0/24:443',
      '10.0.0.50/32:443',
    ]);
    expect(command?.payload.allowlistRules).not.toContain('10.0.0.99/32:443');
  });
});
