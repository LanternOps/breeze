/**
 * Remote-session consent integration coverage.
 *
 * Endpoint consent verdicts arrive only through the authenticated agent
 * command-result channel. A user JWT — including the session owner's — must
 * not be able to report an answer or denial on the endpoint's behalf.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { createAccessToken } from '../../services/jwt';

const { sendCommandToAgentMock } = vi.hoisted(() => ({
  sendCommandToAgentMock: vi.fn((_agentId: string, _command: unknown) => true),
}));
vi.mock('../../routes/agentWs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agentWs')>();
  return { ...actual, sendCommandToAgent: sendCommandToAgentMock };
});

vi.mock('../../services/remoteAccessPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/remoteAccessPolicy')>();
  return {
    ...actual,
    checkRemoteAccess: vi.fn(() => Promise.resolve({ allowed: true })),
    resolveDesktopSessionPolicy: vi.fn(() =>
      Promise.resolve({ clipboard: 'both', idleTimeoutMinutes: 0, maxSessionDurationHours: 0 })
    ),
  };
});

import { remoteRoutes } from '../../routes/remote';
import { devices, remoteSessions, users } from '../../db/schema';

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  const agentId = `agent-consent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId,
    hostname: `consent-test-host-${agentId}`,
    displayName: 'Consent Test Host',
    osType: 'windows',
    osVersion: '11',
    osBuild: '22000',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    // The desktop-start capability gate refuses any device that has not
    // reported revocation-lease support on a heartbeat (503
    // `agent_upgrade_required`). This fixture stands in for an up-to-date
    // agent; the gate itself is covered by remoteRevocationLease.integration.
    revocationLeaseProtocolVersion: 1,
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: no row returned');
  return row.id;
}

async function insertSession(input: {
  deviceId: string;
  orgId: string;
  userId: string;
  status?: 'pending' | 'connecting';
}): Promise<string> {
  // A desktop session with no revocation-lease baseline cannot be issued a
  // lease, so every desktop-start dispatch site refuses it with 503
  // `lease_unavailable`. `createRemoteSession` sets this; a row inserted
  // directly by a fixture has to snapshot the live epoch itself.
  const [live] = await getTestDb()
    .select({ permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const [row] = await getTestDb().insert(remoteSessions).values({
    deviceId: input.deviceId,
    orgId: input.orgId,
    userId: input.userId,
    type: 'desktop',
    status: input.status ?? 'connecting',
    permissionsEpochSnapshot: Number(live!.permissionsEpoch),
    iceCandidates: [],
  }).returning({ id: remoteSessions.id });
  if (!row) throw new Error('insertSession: no row returned');
  return row.id;
}

function buildApp() {
  const app = new Hono();
  app.route('/remote', remoteRoutes);
  return app;
}

async function mintMfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>) {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization' as const,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
}

describe('retired user-authenticated endpoint consent verdicts', () => {
  it.each([
    ['answer', { answer: 'v=0\r\n', consentReason: 'user' }],
    ['deny', { reason: 'user' }],
  ])('does not let the session owner submit an agent %s verdict', async (route, body) => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const deviceId = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
    });

    const res = await buildApp().request(`/remote/sessions/${sessionId}/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(404);
    const [unchanged] = await getTestDb().select({
      status: remoteSessions.status,
      answer: remoteSessions.webrtcAnswer,
      endedAt: remoteSessions.endedAt,
    }).from(remoteSessions).where(eq(remoteSessions.id, sessionId)).limit(1);
    expect(unchanged).toMatchObject({ status: 'connecting', answer: null, endedAt: null });
  });

  it('rejects an incomplete desktop-start generation binding at the database boundary', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await insertDevice(env.organization.id, env.site.id);

    await expect(getTestDb().insert(remoteSessions).values({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
      type: 'desktop',
      status: 'connecting',
      desktopStartCommandId: `desk-start-${randomUUID()}-${randomUUID()}`,
      desktopPromptMode: null,
      iceCandidates: [],
    })).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('POST /remote/sessions/:id/offer prompt identity', () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    sendCommandToAgentMock.mockClear();
  });

  it('ships the partner name rather than the client organization name', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      partnerOptions: { name: 'Olive Technology' },
    });
    const token = await mintMfaToken(env);
    const deviceId = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
      status: 'pending',
    });

    const res = await app.request(`/remote/sessions/${sessionId}/offer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n' }),
    });

    expect(res.status).toBe(200);
    const [, command] = sendCommandToAgentMock.mock.calls[0]!;
    const prompt = (command as { payload: { prompt?: { orgName: string | null; mode: string } } }).payload.prompt;
    expect(prompt?.orgName).toBe('Olive Technology');
    expect(prompt?.orgName).not.toBe(env.organization.name);
    const [stored] = await getTestDb().select({
      commandId: remoteSessions.desktopStartCommandId,
      promptMode: remoteSessions.desktopPromptMode,
    }).from(remoteSessions).where(eq(remoteSessions.id, sessionId)).limit(1);
    expect(stored).toEqual({
      commandId: (command as { id: string }).id,
      promptMode: prompt?.mode,
    });
    expect(stored?.commandId).toMatch(new RegExp(`^desk-start-${sessionId}-`));
  });
});
