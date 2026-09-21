/**
 * SEC-038 W03 (#5534) — the terminal-intent contract, against real Postgres.
 *
 * Every entry point that moves a `remote_sessions` row to a terminal status
 * must go through `terminalIntentSet` so it bumps the SAME generation every
 * start bumps. This file proves that for every writer by driving each one
 * against a real row and reading the fence back. The table is the contract:
 *
 *   **Adding a terminal writer means adding it to `WRITERS` below.** The
 *   static scan in `services/remoteDesktopTerminalIntent.writers.test.ts`
 *   (unit job, no DB) fails the build on any `update(remoteSessions).set({status:
 *   <terminal>})` that does not use the contract; this file is the proof the
 *   contract actually lands on the row for each writer that does.
 *
 * Also proved here, because they need a real row:
 *   - terminal-before-publication: a start whose terminal intent committed
 *     first is refused and nothing is published;
 *   - publication-before-terminal: phase moves pending → confirmed when the
 *     agent's stop result lands, and ONLY for the exact terminal generation;
 *   - REST End keeps returning 200 with a `terminationPhase` field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { createAccessToken } from '../../services/jwt';

const { dispatchCommandToAgentMock, sendCommandToAgentMock } = vi.hoisted(() => ({
  dispatchCommandToAgentMock: vi.fn(async (_agentId: string, _command: unknown) => ({ status: 'sent' as const, via: 'local' as const })),
  sendCommandToAgentMock: vi.fn((_agentId: string, _command: unknown) => true),
}));
vi.mock('../../services/agentCommandRelay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/agentCommandRelay')>();
  return { ...actual, dispatchCommandToAgent: dispatchCommandToAgentMock };
});
vi.mock('../../routes/agentWs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agentWs')>();
  return { ...actual, sendCommandToAgent: sendCommandToAgentMock };
});
// Terminal (PTY) WS plumbing for the two terminalWs writers: the one-time
// ticket is stubbed (minting one is not under test) and the local-install
// step gets a throw seam so the onOpen setup-failure branch is reachable.
const { consumeWsTicketMock, installLocalRemoteConnectionMock } = vi.hoisted(() => ({
  consumeWsTicketMock: vi.fn(),
  installLocalRemoteConnectionMock: vi.fn(),
}));
vi.mock('../../services/remoteSessionAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/remoteSessionAuth')>();
  return { ...actual, consumeWsTicket: consumeWsTicketMock };
});
vi.mock('../../services/remoteWsOwnership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/remoteWsOwnership')>();
  installLocalRemoteConnectionMock.mockImplementation(actual.installLocalRemoteConnection);
  return { ...actual, installLocalRemoteConnection: installLocalRemoteConnectionMock };
});
vi.mock('../../config/partnerTrustMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/partnerTrustMode')>();
  return { ...actual, partnerTrustMode: vi.fn(() => 'off') };
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
const { prepareRevocationLeaseForStartMock } = vi.hoisted(() => ({
  prepareRevocationLeaseForStartMock: vi.fn(async () => ({
    ok: true,
    lease: { sessionId: 'x', token: 't', expiresAt: new Date().toISOString() },
  })),
}));
vi.mock('../../services/remoteRevocationLease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/remoteRevocationLease')>();
  return { ...actual, prepareRevocationLeaseForStart: prepareRevocationLeaseForStartMock };
});
// Viewer-token plumbing for the tunnel→WebRTC upgrade route: the token itself
// and its revocation lookups are stubbed; the row writes stay real.
const { verifyViewerAccessTokenMock } = vi.hoisted(() => ({ verifyViewerAccessTokenMock: vi.fn() }));
vi.mock('../../services/jwt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/jwt')>();
  return {
    ...actual,
    verifyViewerAccessToken: verifyViewerAccessTokenMock,
    createViewerDescendantAccessToken: vi.fn(async () => 'descendant.viewer.token'),
  };
});
vi.mock('../../services/viewerTokenRevocation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/viewerTokenRevocation')>();
  return {
    ...actual,
    isViewerJtiRevoked: vi.fn(async () => false),
    isViewerSessionRevoked: vi.fn(async () => false),
  };
});
vi.mock('../../services/remoteWsAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/remoteWsAuthorization')>();
  return { ...actual, authorizeRemoteSessionContinuation: vi.fn(async () => ({ ok: true })) };
});
// The WS-fallback finalization only writes the row once it holds the agent's
// stop proof; the proof itself is a device_commands round trip that is not
// what is under test here.
vi.mock('../../services/desktopSessionStop', () => ({
  ensureDesktopStreamStopped: vi.fn(async (input: { finalizationId: string }) => ({
    state: 'confirmed',
    commandId: input.finalizationId,
    outcome: 'stopped',
  })),
}));

import { __installAgentSocketForTest, createAgentWsHandlers } from '../../routes/agentWs';
import {
  __createTerminalSharedLeasesForTest,
  __resetTerminalWsForTest,
  closeTerminalSession,
  createTerminalWsRoutes,
  getActiveTerminalSession,
} from '../../routes/terminalWs';
import { remoteRoutes } from '../../routes/remote';
import { vncViewerRoutes } from '../../routes/tunnels';
import { devices, remoteSessions, tunnelSessions, users } from '../../db/schema';
import { db, withSystemDbAccessContext } from '../../db';
import { expireStaleSessions, expireStaleSessionsForUser } from '../../routes/remote/helpers';
import { terminateDeviceRemoteSessions, terminateUserRemoteSessions } from '../../services/remoteSessionTeardown';
import { markSessionRevoked } from '../../services/remoteRevocationLease';
import { finalizeDesktopSessionOnce } from '../../services/desktopSessionFinalization';
import { REAPER_DOMAINS } from '../../jobs/staleCommandReaper';
import { commitDesktopStartIntent } from '../../services/remoteDesktopStartIntent';
import {
  buildStopDesktopCommand,
  commitDesktopTerminalIntent,
  confirmDesktopTerminalIntent,
} from '../../services/remoteDesktopTerminalIntent';

const OFFER = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n';
const CREDENTIAL_HASH = createHash('sha256').update('synthetic-terminal-intent-agent').digest('hex');
const START_UUID = '22222222-2222-4222-8222-222222222222';
/** Seed above zero so a bump is distinguishable from "written from scratch". */
const SEED_GENERATION = 3n;

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;
type LiveStatus = 'pending' | 'connecting' | 'active';

interface Fixture {
  env: Env;
  token: string;
  deviceId: string;
  agentId: string;
  sessionId: string;
}

async function insertDevice(orgId: string, siteId: string): Promise<{ id: string; agentId: string }> {
  const agentId = `agent-tint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId,
    agentTokenHash: CREDENTIAL_HASH,
    hostname: `tint-host-${agentId}`,
    displayName: 'Terminal Intent Host',
    osType: 'windows',
    osVersion: '11',
    osBuild: '22000',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    revocationLeaseProtocolVersion: 1,
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: no row returned');
  return { id: row.id, agentId };
}

async function insertSession(input: {
  deviceId: string;
  orgId: string;
  userId: string;
  status: LiveStatus;
  type?: 'desktop' | 'terminal';
  createdAt?: Date;
  startedAt?: Date | null;
}): Promise<string> {
  const [live] = await getTestDb()
    .select({ permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const sessionId = randomUUID();
  const [row] = await getTestDb().insert(remoteSessions).values({
    id: sessionId,
    deviceId: input.deviceId,
    orgId: input.orgId,
    userId: input.userId,
    type: input.type ?? 'desktop',
    status: input.status,
    desktopStartCommandId: `desk-start-${sessionId}-${START_UUID}`,
    desktopPromptMode: 'off',
    desktopStartGeneration: SEED_GENERATION,
    permissionsEpochSnapshot: Number(live!.permissionsEpoch),
    iceCandidates: [],
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
  }).returning({ id: remoteSessions.id });
  if (!row) throw new Error('insertSession: no row returned');
  return row.id;
}

interface Fence {
  generation: bigint;
  terminalGeneration: bigint | null;
  phase: string;
  status: string;
  endedAt: Date | null;
}

async function readFence(sessionId: string): Promise<Fence> {
  const [row] = await getTestDb().select({
    generation: remoteSessions.desktopStartGeneration,
    terminalGeneration: remoteSessions.terminalGeneration,
    phase: remoteSessions.terminationPhase,
    status: remoteSessions.status,
    endedAt: remoteSessions.endedAt,
  }).from(remoteSessions).where(eq(remoteSessions.id, sessionId)).limit(1);
  if (!row) throw new Error('readFence: session not found');
  return {
    generation: BigInt(row.generation ?? 0),
    terminalGeneration: row.terminalGeneration == null ? null : BigInt(row.terminalGeneration),
    phase: String(row.phase),
    status: String(row.status),
    endedAt: row.endedAt,
  };
}

async function mintToken(env: Env): Promise<string> {
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
    sid: 'tint-session',
  });
}

async function seed(
  status: LiveStatus,
  extra: { type?: 'desktop' | 'terminal'; createdAt?: Date; startedAt?: Date | null } = {},
): Promise<Fixture> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const token = await mintToken(env);
  const device = await insertDevice(env.organization.id, env.site.id);
  const sessionId = await insertSession({
    deviceId: device.id,
    orgId: env.organization.id,
    userId: env.user.id,
    status,
    ...extra,
  });
  return { env, token, deviceId: device.id, agentId: device.agentId, sessionId };
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/remote', remoteRoutes);
  app.route('/vnc-viewer', vncViewerRoutes);
  return app;
}

function jsonRequest(app: Hono, path: string, token: string, body: unknown = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const fakeWs = { send: () => {}, close: () => {} } as unknown as Parameters<
  ReturnType<typeof createAgentWsHandlers>['onMessage']
>[1];

/** Drive the real agent WS onMessage with a command_result from the session's own agent. */
async function agentResult(fx: Fixture, message: Record<string, unknown>): Promise<void> {
  const handlers = createAgentWsHandlers(fx.agentId, {
    deviceId: fx.deviceId,
    orgId: fx.env.organization.id,
    partnerId: fx.env.partner.id,
    credentialTokenHash: CREDENTIAL_HASH,
  });
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage({ data: JSON.stringify({ type: 'command_result', ...message }) } as MessageEvent, fakeWs);
  await handlers.onClose({}, fakeWs);
}

type TerminalWsHandlers = {
  onOpen: (event: unknown, ws: unknown) => Promise<void>;
  onClose: (event: unknown, ws: unknown) => Promise<void> | void;
};

/**
 * Drive the real terminal WS `onOpen` for a PTY-type session so it lands in
 * the live in-memory map (validation, lease claim and the `active` write all
 * run for real against the row; only the ticket and agent socket are stubbed).
 */
async function openTerminalWs(fx: Fixture): Promise<{ handlers: TerminalWsHandlers; ws: { send: () => void; close: () => void } }> {
  // terminalWs sits in an import cycle with agentWs, so its `isAgentConnected`
  // binding is the real one: register a real (fake-transport) agent socket
  // rather than trying to mock the function.
  __installAgentSocketForTest(fx.agentId, { send: () => {} });
  consumeWsTicketMock.mockResolvedValue({
    ok: true,
    sessionId: fx.sessionId,
    sessionType: 'terminal',
    userId: fx.env.user.id,
    expiresAt: Date.now() + 60_000,
  });
  let factory: ((c: unknown) => TerminalWsHandlers) | undefined;
  createTerminalWsRoutes(
    ((f: (c: unknown) => TerminalWsHandlers) => { factory = f; return (_c: unknown, _n: unknown) => {}; }) as never,
    { sharedLeases: __createTerminalSharedLeasesForTest() },
  );
  if (!factory) throw new Error('terminal ws factory was not captured');
  const handlers = factory({
    req: {
      param: (key: string) => (key === 'id' ? fx.sessionId : undefined),
      query: (key: string) => (key === 'ticket' ? 'ticket-tint' : undefined),
      header: () => undefined,
    },
  });
  const ws = { send: () => {}, close: () => {} };
  await handlers.onOpen({}, ws);
  return { handlers, ws };
}

function stopCommandsFor(sessionId: string): Array<{ id: string; payload: Record<string, unknown> }> {
  return dispatchCommandToAgentMock.mock.calls
    .map(([, command]) => command as { id: string; type: string; payload: Record<string, unknown> })
    .filter((command) => command.type === 'stop_desktop' && command.payload.sessionId === sessionId)
    .map(({ id, payload }) => ({ id, payload }));
}

const TEN_MINUTES_AGO = () => new Date(Date.now() - 11 * 60 * 1000);
const A_DAY_AGO = () => new Date(Date.now() - 25 * 60 * 60 * 1000);

interface WriterCase {
  /** `file:function` — the writer's home, so a failure names the site. */
  writer: string;
  seedStatus: LiveStatus;
  seed?: { type?: 'desktop' | 'terminal'; createdAt?: Date; startedAt?: Date | null };
  run: (fx: Fixture) => Promise<void>;
  expectStatus: 'disconnected' | 'failed' | 'denied';
  /** 'pending' = server decided, stop still to be acknowledged; 'confirmed' = endpoint was the source. */
  expectPhase: 'pending' | 'confirmed';
  /** Whether this writer sends `stop_desktop` — if so it must carry the terminal generation. */
  sendsStop: boolean;
}

/**
 * THE TABLE. One row per terminal writer in `apps/api/src`. The static scan
 * (`remoteDesktopTerminalIntent.writers.test.ts`) enumerates the same set from
 * source; keep the two in step.
 */
const WRITERS: WriterCase[] = [
  {
    writer: 'routes/remote/sessions.ts:POST /sessions/:id/end',
    seedStatus: 'active',
    run: async (fx) => {
      const res = await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/end`, fx.token);
      expect(res.status).toBe(200);
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: true,
  },
  {
    writer: 'routes/remote/sessions.ts:DELETE /sessions/stale',
    seedStatus: 'connecting',
    seed: { createdAt: TEN_MINUTES_AGO() },
    run: async (fx) => {
      const res = await buildApp().request(`/remote/sessions/stale?deviceId=${fx.deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fx.token}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ids).toContain(fx.sessionId);
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: true,
  },
  {
    writer: 'routes/remote/sessions.ts:POST /sessions (pre-create straggler sweep)',
    seedStatus: 'active',
    run: async (fx) => {
      const res = await jsonRequest(buildApp(), '/remote/sessions', fx.token, { deviceId: fx.deviceId, type: 'desktop' });
      expect(res.status).toBe(201);
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: true,
  },
  {
    writer: 'routes/tunnels.ts:POST /vnc-viewer/upgrade-to-webrtc (straggler sweep)',
    seedStatus: 'active',
    run: async (fx) => {
      const [tunnel] = await getTestDb().insert(tunnelSessions).values({
        orgId: fx.env.organization.id,
        deviceId: fx.deviceId,
        userId: fx.env.user.id,
        type: 'vnc',
        status: 'active',
        targetHost: '127.0.0.1',
        targetPort: 5900,
      }).returning({ id: tunnelSessions.id });
      verifyViewerAccessTokenMock.mockResolvedValue({
        sub: fx.env.user.id,
        email: fx.env.user.email,
        sessionId: tunnel!.id,
        jti: `jti-${tunnel!.id}`,
        mfaSatisfied: true,
      });
      const res = await jsonRequest(buildApp(), '/vnc-viewer/upgrade-to-webrtc', 'viewer.token');
      expect(res.status).toBe(200);
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: true,
  },
  {
    writer: 'routes/remote/helpers.ts:expireStaleSessions',
    seedStatus: 'pending',
    seed: { createdAt: TEN_MINUTES_AGO() },
    run: async (fx) => {
      await withSystemDbAccessContext(() => expireStaleSessions(fx.env.organization.id));
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: false,
  },
  {
    writer: 'routes/remote/helpers.ts:expireStaleSessionsForUser',
    seedStatus: 'connecting',
    seed: { createdAt: TEN_MINUTES_AGO() },
    run: async (fx) => {
      await withSystemDbAccessContext(() => expireStaleSessionsForUser(fx.env.user.id));
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: false,
  },
  {
    writer: 'services/remoteSessionTeardown.ts:terminateUserRemoteSessions',
    seedStatus: 'active',
    run: async (fx) => {
      expect(await terminateUserRemoteSessions(fx.env.user.id)).toBeGreaterThanOrEqual(1);
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: true,
  },
  {
    writer: 'services/remoteSessionTeardown.ts:terminateDeviceRemoteSessions',
    seedStatus: 'connecting',
    run: async (fx) => {
      expect(await terminateDeviceRemoteSessions(fx.deviceId)).toBeGreaterThanOrEqual(1);
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: true,
  },
  {
    writer: 'services/remoteRevocationLease.ts:markSessionRevoked',
    seedStatus: 'active',
    run: async (fx) => {
      const row = await markSessionRevoked(fx.sessionId, 'user_inactive');
      expect(row).toMatchObject({ id: fx.sessionId, terminalGeneration: SEED_GENERATION + 1n });
    },
    expectStatus: 'disconnected',
    // markSessionRevoked only writes the row; its caller (renewRevocationLease)
    // hands the returned row to teardownDisconnectedSessions for the stop.
    expectPhase: 'pending',
    sendsStop: false,
  },
  {
    writer: 'jobs/staleCommandReaper.ts:reapStaleRemoteSessions (never established)',
    seedStatus: 'connecting',
    seed: { createdAt: TEN_MINUTES_AGO() },
    run: async () => {
      const domain = REAPER_DOMAINS.find(([name]) => name === 'remoteSessions');
      if (!domain) throw new Error('remoteSessions reaper domain missing');
      await withSystemDbAccessContext(() => domain[1]());
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: false,
  },
  {
    writer: 'jobs/staleCommandReaper.ts:reapStaleRemoteSessions (zombie active)',
    seedStatus: 'active',
    seed: { startedAt: A_DAY_AGO() },
    run: async () => {
      const domain = REAPER_DOMAINS.find(([name]) => name === 'remoteSessions');
      if (!domain) throw new Error('remoteSessions reaper domain missing');
      await withSystemDbAccessContext(() => domain[1]());
    },
    expectStatus: 'disconnected',
    expectPhase: 'pending',
    sendsStop: false,
  },
  {
    writer: 'services/desktopSessionFinalization.ts:finalizeDesktopSessionOnce',
    seedStatus: 'active',
    run: async (fx) => {
      const outcome = await finalizeDesktopSessionOnce({
        version: 1,
        finalizationId: randomUUID(),
        sessionId: fx.sessionId,
        connection: { connectionId: randomUUID(), generation: 1, instanceId: randomUUID(), leaseToken: randomUUID() },
        orgId: fx.env.organization.id,
        userId: fx.env.user.id,
        deviceId: fx.deviceId,
        reason: 'client_close',
        terminalStatus: 'disconnected',
        endedAt: new Date().toISOString(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        inputEvents: 0,
        frameBytes: 0,
      });
      expect(outcome).toBe('finalized');
    },
    expectStatus: 'disconnected',
    // The stop proof is already in hand before the row is written.
    expectPhase: 'confirmed',
    sendsStop: false,
  },
  {
    writer: 'routes/agentWs.ts:desk-disconnect peer_disconnected',
    seedStatus: 'active',
    run: async (fx) => {
      await agentResult(fx, {
        commandId: `desk-disconnect-${fx.sessionId}`,
        status: 'completed',
        result: { event: 'peer_disconnected', sessionId: fx.sessionId },
      });
    },
    expectStatus: 'disconnected',
    expectPhase: 'confirmed',
    sendsStop: false,
  },
  {
    writer: 'routes/agentWs.ts:desk-start consent_denied',
    seedStatus: 'connecting',
    run: async (fx) => {
      await agentResult(fx, {
        commandId: `desk-start-${fx.sessionId}-${START_UUID}`,
        status: 'completed',
        result: { event: 'consent_denied', sessionId: fx.sessionId, reason: 'user' },
      });
    },
    expectStatus: 'denied',
    expectPhase: 'confirmed',
    sendsStop: false,
  },
  {
    writer: 'routes/agentWs.ts:desk-start failed',
    seedStatus: 'connecting',
    run: async (fx) => {
      await agentResult(fx, {
        commandId: `desk-start-${fx.sessionId}-${START_UUID}`,
        status: 'failed',
        error: 'capture exploded',
      });
    },
    expectStatus: 'failed',
    expectPhase: 'confirmed',
    sendsStop: false,
  },
  {
    writer: 'routes/terminalWs.ts:closeExactTerminalConnection (via closeTerminalSession)',
    seedStatus: 'pending',
    seed: { type: 'terminal' },
    run: async (fx) => {
      await openTerminalWs(fx);
      expect(getActiveTerminalSession(fx.sessionId)).toBeDefined();
      expect((await readFence(fx.sessionId)).status).toBe('active');
      expect(await closeTerminalSession(fx.sessionId)).toBe(true);
    },
    expectStatus: 'disconnected',
    // A PTY row has no endpoint acknowledgement flow: confirmed on commit.
    expectPhase: 'confirmed',
    sendsStop: false,
  },
  {
    writer: 'routes/terminalWs.ts:onOpen setup-failure (validated, not yet stored)',
    seedStatus: 'pending',
    seed: { type: 'terminal' },
    run: async (fx) => {
      // Throw between validation and the local install: that is the only
      // window the else-branch at the end of onOpen covers.
      installLocalRemoteConnectionMock.mockImplementationOnce(() => {
        throw new Error('injected: local install exploded');
      });
      await openTerminalWs(fx);
      expect(getActiveTerminalSession(fx.sessionId)).toBeUndefined();
    },
    expectStatus: 'failed',
    expectPhase: 'confirmed',
    sendsStop: false,
  },
];

describe('SEC-038 W03 — one terminal-intent contract for every terminal writer', () => {
  beforeEach(() => {
    dispatchCommandToAgentMock.mockClear();
    sendCommandToAgentMock.mockClear();
  });
  afterEach(() => {
    __resetTerminalWsForTest();
  });

  describe.each(WRITERS)('$writer', (writerCase) => {
    it('bumps the shared generation, records it as terminal, and sets the phase', async () => {
      const fx = await seed(writerCase.seedStatus, writerCase.seed);
      const before = await readFence(fx.sessionId);
      expect(before).toMatchObject({ generation: SEED_GENERATION, terminalGeneration: null, phase: 'none' });

      await writerCase.run(fx);

      const after = await readFence(fx.sessionId);
      expect(after.status).toBe(writerCase.expectStatus);
      expect(after.endedAt).not.toBeNull();
      // The load-bearing assertion: the terminal decision consumed a generation
      // in the same total order the starts use, and recorded which one.
      expect(after.generation).toBe(SEED_GENERATION + 1n);
      expect(after.terminalGeneration).toBe(SEED_GENERATION + 1n);
      expect(after.phase).toBe(writerCase.expectPhase);

      const stops = stopCommandsFor(fx.sessionId);
      if (writerCase.sendsStop) {
        expect(stops.length).toBeGreaterThanOrEqual(1);
        for (const stop of stops) {
          expect(stop.id).toBe(`desk-stop-${fx.sessionId}-${SEED_GENERATION + 1n}`);
          expect(stop.payload.terminalGeneration).toBe(String(SEED_GENERATION + 1n));
          expect(typeof stop.payload.terminalGeneration).toBe('string');
        }
      }
    });

    it('is a no-op on a row that is already terminal (never rewrites a terminal decision)', async () => {
      const fx = await seed(writerCase.seedStatus, writerCase.seed);
      // A first terminal decision wins the row.
      const first = await withSystemDbAccessContext(() => commitDesktopTerminalIntent({
        sessionId: fx.sessionId,
        write: { status: 'failed', endedAt: new Date(Date.now() - 5_000), errorMessage: 'first' },
        phase: 'confirmed',
      }));
      expect(first).toMatchObject({ ok: true, terminalGeneration: SEED_GENERATION + 1n });
      const settled = await readFence(fx.sessionId);

      // Routes refuse up front (400) on a terminal row; direct writers just
      // match nothing. Either way the row must not change.
      await writerCase.run(fx).catch(() => undefined);

      expect(await readFence(fx.sessionId)).toEqual(settled);
    });
  });

  it('a session of a non-desktop type is confirmed the moment it commits (no endpoint to ask)', async () => {
    const fx = await seed('active', { type: 'terminal' });
    expect(await terminateUserRemoteSessions(fx.env.user.id)).toBeGreaterThanOrEqual(1);
    expect(await readFence(fx.sessionId)).toMatchObject({
      status: 'disconnected',
      generation: SEED_GENERATION + 1n,
      terminalGeneration: SEED_GENERATION + 1n,
      phase: 'confirmed',
    });
    expect(stopCommandsFor(fx.sessionId)).toEqual([]);
  });

  it('terminal-before-publication: a start whose terminal intent committed first is refused and publishes nothing', async () => {
    const fx = await seed('active');
    const end = await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/end`, fx.token);
    expect(end.status).toBe(200);
    sendCommandToAgentMock.mockClear();

    // Direct attempt against the contract: the terminal PHASE is what W02
    // keys on, and it reports it as 'terminal' even though the status is also
    // no longer live. (The route's own status gate refuses earlier with 400.)
    const start = await withSystemDbAccessContext(() => commitDesktopStartIntent({
      sessionId: fx.sessionId,
      startCommandId: `desk-start-${fx.sessionId}-${randomUUID()}`,
      promptMode: 'off',
      offer: OFFER,
    }));
    expect(start).toEqual({ ok: false, reason: 'terminal' });

    const res = await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/offer`, fx.token, { offer: OFFER });
    expect(res.status).toBe(400);
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
    expect((await readFence(fx.sessionId)).generation).toBe(SEED_GENERATION + 1n);
  });

  it('REST End returns 200 (not 202) with the termination phase in the body', async () => {
    const fx = await seed('active');
    const res = await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/end`, fx.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: fx.sessionId, status: 'disconnected', terminationPhase: 'pending' });
    expect(body.terminalGeneration).toBe(String(SEED_GENERATION + 1n));
  });

  it('publication-before-terminal: phase moves pending → confirmed when the agent acknowledges the exact stop', async () => {
    const fx = await seed('active');
    const end = await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/end`, fx.token);
    expect(end.status).toBe(200);
    const [stop] = stopCommandsFor(fx.sessionId);
    expect(stop).toBeDefined();
    expect((await readFence(fx.sessionId)).phase).toBe('pending');

    await agentResult(fx, { commandId: stop!.id, status: 'completed', result: { stopped: true } });

    expect((await readFence(fx.sessionId)).phase).toBe('confirmed');
  });

  it('a stale or foreign stop result cannot confirm the terminal intent', async () => {
    const fx = await seed('active');
    const end = await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/end`, fx.token);
    expect(end.status).toBe(200);
    const terminalGeneration = SEED_GENERATION + 1n;

    // Older generation.
    await agentResult(fx, {
      commandId: buildStopDesktopCommand(fx.sessionId, terminalGeneration - 1n).id,
      status: 'completed',
      result: { stopped: true },
    });
    expect((await readFence(fx.sessionId)).phase).toBe('pending');

    // Legacy identity with no generation at all.
    await agentResult(fx, { commandId: `desk-stop-${fx.sessionId}`, status: 'completed', result: { stopped: true } });
    expect((await readFence(fx.sessionId)).phase).toBe('pending');

    // A failed stop is not an acknowledgement.
    await agentResult(fx, {
      commandId: buildStopDesktopCommand(fx.sessionId, terminalGeneration).id,
      status: 'failed',
      error: 'nope',
    });
    expect((await readFence(fx.sessionId)).phase).toBe('pending');

    // Right generation, wrong device: a different agent must not confirm it.
    const other = await insertDevice(fx.env.organization.id, fx.env.site.id);
    await agentResult(
      { ...fx, deviceId: other.id, agentId: other.agentId },
      { commandId: buildStopDesktopCommand(fx.sessionId, terminalGeneration).id, status: 'completed', result: { stopped: true } },
    );
    expect((await readFence(fx.sessionId)).phase).toBe('pending');

    // And the direct contract agrees.
    await expect(withSystemDbAccessContext(() => confirmDesktopTerminalIntent({
      sessionId: fx.sessionId,
      deviceId: fx.deviceId,
      terminalGeneration: terminalGeneration + 1n,
    }))).resolves.toBe('no_match');
    await expect(withSystemDbAccessContext(() => confirmDesktopTerminalIntent({
      sessionId: fx.sessionId,
      deviceId: fx.deviceId,
      terminalGeneration,
    }))).resolves.toBe('confirmed');
  });

  it('a confirmed row stays confirmed: a second acknowledgement matches nothing', async () => {
    const fx = await seed('active');
    await jsonRequest(buildApp(), `/remote/sessions/${fx.sessionId}/end`, fx.token);
    const terminalGeneration = SEED_GENERATION + 1n;
    await expect(withSystemDbAccessContext(() => confirmDesktopTerminalIntent({
      sessionId: fx.sessionId, deviceId: fx.deviceId, terminalGeneration,
    }))).resolves.toBe('confirmed');
    await expect(withSystemDbAccessContext(() => confirmDesktopTerminalIntent({
      sessionId: fx.sessionId, deviceId: fx.deviceId, terminalGeneration,
    }))).resolves.toBe('no_match');
  });

  it('rejects a terminal row whose phase and generation disagree at the database boundary', async () => {
    // Belt-and-braces on the W02 CHECK: the contract can never write one
    // without the other, and the database refuses it if anything else tries.
    const fx = await seed('active');
    await expect(getTestDb().update(remoteSessions)
      .set({ terminationPhase: 'confirmed' })
      .where(eq(remoteSessions.id, fx.sessionId)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
