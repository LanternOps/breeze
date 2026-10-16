/**
 * #5533 — start-intent ordering, against real Postgres.
 *
 * The property under test is an INTERLEAVING, so none of it can be proved by a
 * mocked Drizzle suite: a mock cannot hold a `FOR UPDATE` row lock, cannot show
 * a second connection blocking on it, and cannot roll a failed request's CAS
 * back. Every assertion here drives the real route against the real row.
 *
 * Two facts about where the transaction boundaries actually sit, because they
 * decide which races are even reachable and are easy to get wrong:
 *
 *  - The JWT route (`POST /remote/sessions/:id/offer`) runs inside ONE
 *    request transaction (`withDbAccessContext` opens it), so the row lock
 *    taken by `commitDesktopStartIntent` is held until the response is
 *    produced. A concurrent End on another connection therefore BLOCKS rather
 *    than interleaving — it cannot win the row mid-request. The interleave that
 *    IS reachable there is a same-transaction one (something the request itself
 *    does between the CAS and the send), which is what the lease-mock injection
 *    below reproduces.
 *  - The viewer-token route (`POST /desktop-ws/:id/viewer/offer`) has no
 *    request-scoped context; it opens a SEPARATE `withSystemDbAccessContext`
 *    transaction per database operation, so the lock is released at the commit
 *    and a genuine cross-connection End between the commit and the send is
 *    reachable. That one is driven here with a real second connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';

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

// The lease mint is the one `await` the JWT offer route performs between the
// start-intent CAS and `sendCommandToAgent`, which makes it the injection point
// for "something happened in the publish window".
const { prepareRevocationLeaseForStartMock } = vi.hoisted(() => ({
  prepareRevocationLeaseForStartMock: vi.fn(),
}));
vi.mock('../../services/remoteRevocationLease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/remoteRevocationLease')>();
  return { ...actual, prepareRevocationLeaseForStart: prepareRevocationLeaseForStartMock };
});

// Viewer-token plumbing only. Everything the viewer route authorizes against
// (`authorizeLiveRemoteSessionAccess`, the session/device/user rows, RLS) stays
// real — only the token itself and its revocation lookups are stubbed, because
// minting one requires the connect-code exchange, which is not what is under
// test here.
const { verifyViewerAccessTokenMock, logSessionAuditMock } = vi.hoisted(() => ({
  verifyViewerAccessTokenMock: vi.fn(),
  logSessionAuditMock: vi.fn(async () => undefined),
}));
vi.mock('../../services/jwt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/jwt')>();
  return { ...actual, verifyViewerAccessToken: verifyViewerAccessTokenMock };
});
vi.mock('../../services/viewerTokenRevocation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/viewerTokenRevocation')>();
  return {
    ...actual,
    isViewerJtiRevoked: vi.fn(async () => false),
    isViewerSessionRevoked: vi.fn(async () => false),
  };
});
// The audit write is the await the viewer route performs between the CAS and
// the pre-publication re-read — the injection point for the genuine
// cross-connection race that route (unlike the JWT one) is exposed to.
vi.mock('../../routes/remote/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/remote/helpers')>();
  return { ...actual, logSessionAudit: logSessionAuditMock };
});

import { createDesktopWsRoutes } from '../../routes/desktopWs';
import { remoteRoutes } from '../../routes/remote';
import { devices, remoteSessions, users } from '../../db/schema';
import { db, withSystemDbAccessContext } from '../../db';
import {
  assertDesktopStartIntentCurrent,
  commitDesktopStartIntent,
  commitDesktopStreamStartIntent,
  formatDesktopGeneration,
} from '../../services/remoteDesktopStartIntent';
import { remoteSessionStaleCondition } from '../../services/remoteSessionStaleness';
import { getRedis } from '../../services/redis';
import { desktopStartInFlightRedisKey } from '../../services/desktopStartInFlight';

const OFFER = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n';
const LEASE = { lease: { sessionId: 'x', token: 't', expiresAt: new Date().toISOString() } };

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  const agentId = `agent-fence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId,
    hostname: `fence-host-${agentId}`,
    displayName: 'Fence Test Host',
    osType: 'windows',
    osVersion: '11',
    osBuild: '22000',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    revocationLeaseProtocolVersion: 1,
    desktopFenceProtocolVersion: 1,
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: no row returned');
  return row.id;
}

async function insertSession(input: {
  deviceId: string;
  orgId: string;
  userId: string;
  status?: 'pending' | 'connecting' | 'active';
}): Promise<string> {
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
    status: input.status ?? 'pending',
    permissionsEpochSnapshot: Number(live!.permissionsEpoch),
    iceCandidates: [],
  }).returning({ id: remoteSessions.id });
  if (!row) throw new Error('insertSession: no row returned');
  return row.id;
}

/**
 * The raw shape of W03's terminal-intent commit (`terminalIntentSet` in
 * services/remoteDesktopTerminalIntent.ts), written directly so this file
 * tests the START side against the bare row contract rather than through the
 * terminal service: bump the shared generation, record it as the terminal
 * one, and move the phase to 'pending'. Both `set` expressions read the OLD
 * value, so they land on the same number — which is the contract.
 */
async function commitTerminalIntentDirectly(
  sessionId: string,
  options: { handle?: ReturnType<typeof getTestDb>; keepStatus?: boolean } = {},
): Promise<void> {
  const handle = options.handle ?? getTestDb();
  await handle.update(remoteSessions).set({
    desktopStartGeneration: sql`${remoteSessions.desktopStartGeneration} + 1`,
    terminalGeneration: sql`${remoteSessions.desktopStartGeneration} + 1`,
    terminationPhase: 'pending',
    // `keepStatus` isolates the PHASE guard: it is the only signal left once
    // the status still reads live, which is exactly the window W03's
    // pending→confirmed teardown opens.
    ...(options.keepStatus ? {} : { status: 'disconnected' as const, endedAt: new Date() }),
  }).where(eq(remoteSessions.id, sessionId));
}

/**
 * What the agent's answer does to the row (routes/agentWs.ts, "Stored WebRTC
 * answer"): the start stops being in flight, so a later offer is a reconnect.
 */
async function storeAnswerDirectly(sessionId: string): Promise<void> {
  await getTestDb().update(remoteSessions).set({
    webrtcAnswer: 'v=0\r\nanswer\r\n',
    status: 'active',
    startedAt: new Date(),
  }).where(eq(remoteSessions.id, sessionId));
}

async function readFence(sessionId: string): Promise<{
  generation: bigint;
  terminalGeneration: bigint | null;
  phase: string;
  commandId: string | null;
  status: string;
}> {
  const [row] = await getTestDb().select({
    generation: remoteSessions.desktopStartGeneration,
    terminalGeneration: remoteSessions.terminalGeneration,
    phase: remoteSessions.terminationPhase,
    commandId: remoteSessions.desktopStartCommandId,
    status: remoteSessions.status,
  }).from(remoteSessions).where(eq(remoteSessions.id, sessionId)).limit(1);
  if (!row) throw new Error('readFence: session not found');
  return {
    generation: BigInt(row.generation ?? 0),
    terminalGeneration: row.terminalGeneration == null ? null : BigInt(row.terminalGeneration),
    phase: String(row.phase),
    commandId: row.commandId,
    status: String(row.status),
  };
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/remote', remoteRoutes);
  return app;
}

async function mintToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>): Promise<string> {
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
    sid: 'fence-session',
  });
}

async function seed(status?: 'pending' | 'connecting' | 'active') {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const token = await mintToken(env);
  const deviceId = await insertDevice(env.organization.id, env.site.id);
  const sessionId = await insertSession({
    deviceId,
    orgId: env.organization.id,
    userId: env.user.id,
    status,
  });
  return { env, token, deviceId, sessionId };
}

function offer(app: Hono, sessionId: string, token: string) {
  return app.request(`/remote/sessions/${sessionId}/offer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer: OFFER }),
  });
}

describe('desktop start-intent generation fence', () => {
  beforeEach(async () => {
    sendCommandToAgentMock.mockClear();
    prepareRevocationLeaseForStartMock.mockReset();
    prepareRevocationLeaseForStartMock.mockResolvedValue({ ok: true, ...LEASE });
    // The #8947 in-flight marker fails open on a client that is not ready yet;
    // connect the app's lazily-created client so these tests exercise it.
    await getRedis()?.ping();
  });

  it('publishes a start with a generation that strictly increases on every re-offer', async () => {
    const { token, sessionId } = await seed('pending');
    const app = buildApp();

    expect((await readFence(sessionId)).generation).toBe(0n);

    const first = await offer(app, sessionId, token);
    expect(first.status).toBe(200);
    const afterFirst = await readFence(sessionId);
    expect(afterFirst.generation).toBe(1n);

    // A re-offer supersedes once the first start was answered (a reconnect).
    // While it is still unanswered a re-offer is refused — see the #8947 tests.
    await storeAnswerDirectly(sessionId);

    const second = await offer(app, sessionId, token);
    expect(second.status).toBe(200);
    expect((await readFence(sessionId)).generation).toBe(2n);

    // Canonical decimal string on the wire — never a JSON number, never
    // widened through a JavaScript Number.
    const payloads = sendCommandToAgentMock.mock.calls.map(
      ([, command]) => (command as { payload: { startGeneration: unknown } }).payload.startGeneration
    );
    expect(payloads).toEqual(['1', '2']);
    expect(payloads.every((g) => typeof g === 'string')).toBe(true);
  });

  it('refuses a start whose terminal intent committed first, and publishes nothing', async () => {
    const { token, sessionId } = await seed('connecting');
    // Status left live on purpose: the terminal PHASE alone must refuse the
    // start. (When the terminal decision also flips the status — the usual
    // case — the route's pre-existing status gate refuses it earlier with 400;
    // that is covered by the next test.)
    await commitTerminalIntentDirectly(sessionId, { keepStatus: true });
    const before = await readFence(sessionId);
    expect(before).toMatchObject({ phase: 'pending', status: 'connecting' });

    const res = await offer(buildApp(), sessionId, token);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SESSION_TERMINAL');
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
    // The refused start left the row exactly as the terminal decision wrote it.
    expect(await readFence(sessionId)).toMatchObject({
      generation: before.generation,
      phase: 'pending',
      commandId: null,
    });
  });

  it('refuses a start on a session the terminal decision also took out of a live status', async () => {
    const { token, sessionId } = await seed('connecting');
    await commitTerminalIntentDirectly(sessionId);

    const res = await offer(buildApp(), sessionId, token);

    expect(res.status).toBe(400);
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
    expect(await readFence(sessionId)).toMatchObject({ phase: 'pending', commandId: null });
  });

  it('refuses to publish when a terminal intent lands inside the publish window', async () => {
    const { token, sessionId } = await seed('connecting');

    // The terminal write happens inside the request's OWN transaction, at the
    // one await between the CAS and the send. That is the reachable shape of
    // this race on the JWT route: an out-of-transaction End would instead block
    // on the row lock the CAS still holds.
    prepareRevocationLeaseForStartMock.mockImplementation(async () => {
      await commitTerminalIntentDirectly(sessionId, { handle: db as never, keepStatus: true });
      return { ok: true, ...LEASE };
    });

    const res = await offer(buildApp(), sessionId, token);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SESSION_TERMINAL');
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
  });

  it('publishes nothing when the request fails after the CAS, and the consumed generation is never re-published', async () => {
    const { token, sessionId } = await seed('pending');
    prepareRevocationLeaseForStartMock.mockRejectedValueOnce(new Error('lease mint exploded'));

    const failed = await offer(buildApp(), sessionId, token);
    expect(failed.status).toBe(500);
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();

    // Documented, deliberately: the CAS does NOT roll back. Hono converts the
    // thrown error into a 500 inside the db-context middleware's `await
    // next()`, so the request transaction commits. That is fail-CLOSED — the
    // generation was consumed and can never be published, and a later start
    // must use a strictly newer one. (If the error boundary ever moves outside
    // the context middleware this flips to generation 0n; that would also be
    // correct, so the value is asserted here to make the change visible rather
    // than silent.)
    const afterFailure = await readFence(sessionId);
    expect(afterFailure.generation).toBe(1n);
    expect(afterFailure.phase).toBe('none');

    const ok = await offer(buildApp(), sessionId, token);
    expect(ok.status).toBe(200);
    expect(sendCommandToAgentMock).toHaveBeenCalledTimes(1);
    const [, command] = sendCommandToAgentMock.mock.calls[0]!;
    expect((command as { payload: { startGeneration: string } }).payload.startGeneration).toBe('2');
  });

  it('reports a superseded generation once a newer start has committed', async () => {
    const { sessionId } = await seed('pending');

    const first = await withSystemDbAccessContext(() => commitDesktopStartIntent({
      sessionId,
      startCommandId: `desk-start-${sessionId}-11111111-1111-4111-8111-111111111111`,
      promptMode: 'off',
      consentUnavailableBehavior: null,
      offer: OFFER,
    }));
    expect(first).toMatchObject({ ok: true, generation: 1n });
    await storeAnswerDirectly(sessionId);

    const second = await withSystemDbAccessContext(() => commitDesktopStartIntent({
      sessionId,
      startCommandId: `desk-start-${sessionId}-22222222-2222-4222-8222-222222222222`,
      promptMode: 'off',
      consentUnavailableBehavior: null,
      offer: 'v=0\r\nDIFFERENT\r\n',
    }));
    expect(second).toMatchObject({ ok: true, generation: 2n });

    // The older start — same session, different payload — can no longer be
    // published: its generation is not the current one.
    await expect(withSystemDbAccessContext(() =>
      assertDesktopStartIntentCurrent(sessionId, 1n)
    )).resolves.toEqual({ ok: false, reason: 'superseded' });
    await expect(withSystemDbAccessContext(() =>
      assertDesktopStartIntentCurrent(sessionId, 2n)
    )).resolves.toEqual({ ok: true });
  });

  it('refuses the WS-fallback start intent on a terminal session and bumps otherwise', async () => {
    const { sessionId } = await seed('pending');
    const streamStart = (commandSuffix: string) => ({
      sessionId,
      startCommandId: `desk-start-${sessionId}-${commandSuffix}`,
      promptMode: 'off' as const,
      consentUnavailableBehavior: null,
    });

    const live = await withSystemDbAccessContext(() =>
      commitDesktopStreamStartIntent(streamStart('11111111-1111-4111-8111-111111111111'))
    );
    expect(live).toMatchObject({ ok: true, generation: 1n });
    // Connecting until the agent accepts this exact start; never active here.
    expect((await readFence(sessionId)).status).toBe('connecting');

    await commitTerminalIntentDirectly(sessionId);
    const afterTerminal = await withSystemDbAccessContext(() =>
      commitDesktopStreamStartIntent(streamStart('22222222-2222-4222-8222-222222222222'))
    );
    expect(afterTerminal).toEqual({ ok: false, reason: 'terminal' });
  });

  // A WebSocket-fallback start waits in 'connecting' for the agent's answer —
  // through a consent prompt of up to about a minute and a half. The stale
  // cutoff for a connecting row runs from the start attempt, not from when
  // the session row was created, so that wait is never expired as stale.
  it('does not expire a WS-fallback start waiting on its answer as stale, however old the session row', async () => {
    const { sessionId } = await seed('pending');
    await getTestDb().execute(sql`
      UPDATE remote_sessions SET created_at = now() - interval '10 minutes' WHERE id = ${sessionId}::uuid
    `);
    const { sessionId: plainOld } = await seed('connecting');
    await getTestDb().execute(sql`
      UPDATE remote_sessions SET created_at = now() - interval '10 minutes' WHERE id = ${plainOld}::uuid
    `);

    const started = await withSystemDbAccessContext(() => commitDesktopStreamStartIntent({
      sessionId,
      startCommandId: `desk-start-${sessionId}-33333333-3333-4333-8333-333333333333`,
      promptMode: 'consent',
      consentUnavailableBehavior: 'block',
    }));
    expect(started.ok).toBe(true);

    const stale = await getTestDb()
      .select({ id: remoteSessions.id })
      .from(remoteSessions)
      .where(and(inArray(remoteSessions.id, [sessionId, plainOld]), remoteSessionStaleCondition(new Date())));
    expect(stale.map((r) => r.id)).toEqual([plainOld]);
  });

  it('refuses a start intent on a session that no longer exists', async () => {
    await expect(withSystemDbAccessContext(() => assertDesktopStartIntentCurrent(
      '00000000-0000-4000-8000-000000000000',
      1n,
    ))).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects a terminal phase outside the enum at the database boundary', async () => {
    const { sessionId } = await seed('pending');
    await expect(getTestDb().execute(sql`
      UPDATE remote_sessions SET termination_phase = 'bogus' WHERE id = ${sessionId}::uuid
    `)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a terminal phase with no terminal generation at the database boundary', async () => {
    const { sessionId } = await seed('pending');
    await expect(getTestDb().execute(sql`
      UPDATE remote_sessions SET termination_phase = 'pending' WHERE id = ${sessionId}::uuid
    `)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('viewer offer: a terminal intent committed on another connection inside the publish window refuses publication', async () => {
    const { env, sessionId } = await seed('connecting');
    verifyViewerAccessTokenMock.mockResolvedValue({
      sub: env.user.id,
      email: env.user.email,
      sessionId,
      jti: `jti-${sessionId}`,
    });
    // The viewer route commits its CAS in its own transaction, so the row lock
    // is released before the audit write — a real second connection can and
    // does win the row here.
    logSessionAuditMock.mockImplementationOnce(async () => {
      await commitTerminalIntentDirectly(sessionId);
    });

    const app = createDesktopWsRoutes(
      vi.fn((_factory: unknown) => (_c: unknown, _next: unknown) => {}) as never,
    );
    const res = await app.request(`/${sessionId}/viewer/offer`, {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer.token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer: OFFER }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SESSION_TERMINAL');
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
    expect((await readFence(sessionId)).phase).toBe('pending');
  });

  // #8947: one viewer window posted two offers ~250 ms apart; both were
  // accepted, two start_desktop commands went out, and the first peer was
  // orphaned. A second offer while the first start is unanswered is refused.
  describe('concurrent second offer (#8947)', () => {
    function viewerApp() {
      return createDesktopWsRoutes(
        vi.fn((_factory: unknown) => (_c: unknown, _next: unknown) => {}) as never,
      );
    }

    function viewerOffer(app: ReturnType<typeof viewerApp>, sessionId: string) {
      return app.request(`/${sessionId}/viewer/offer`, {
        method: 'POST',
        headers: { Authorization: 'Bearer viewer.token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: OFFER }),
      });
    }

    async function seedViewer() {
      const seeded = await seed('pending');
      verifyViewerAccessTokenMock.mockResolvedValue({
        sub: seeded.env.user.id,
        email: seeded.env.user.email,
        sessionId: seeded.sessionId,
        jti: `jti-${seeded.sessionId}`,
      });
      return seeded;
    }

    it('JWT route: refuses a second offer while the first start is unanswered, and dispatches one start', async () => {
      const { token, sessionId } = await seed('pending');
      const app = buildApp();

      expect((await offer(app, sessionId, token)).status).toBe(200);
      const second = await offer(app, sessionId, token);

      expect(second.status).toBe(409);
      expect((await second.json()).code).toBe('START_IN_FLIGHT');
      expect(sendCommandToAgentMock).toHaveBeenCalledTimes(1);
      // The first start keeps its generation and identity.
      const fence = await readFence(sessionId);
      expect(fence.generation).toBe(1n);
      const [, command] = sendCommandToAgentMock.mock.calls[0]!;
      expect(fence.commandId).toBe((command as { id: string }).id);
    });

    it('viewer route: of two concurrent offers exactly one starts', async () => {
      const { sessionId } = await seedViewer();
      const app = viewerApp();

      const results = await Promise.all([viewerOffer(app, sessionId), viewerOffer(app, sessionId)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const refused = results.find((r) => r.status === 409)!;
      expect((await refused.json()).code).toBe('START_IN_FLIGHT');
      expect(sendCommandToAgentMock).toHaveBeenCalledTimes(1);
      expect((await readFence(sessionId)).generation).toBe(1n);
    });

    it('accepts a reconnect offer once the first start was answered', async () => {
      const { sessionId } = await seedViewer();
      const app = viewerApp();

      expect((await viewerOffer(app, sessionId)).status).toBe(200);
      await storeAnswerDirectly(sessionId);
      expect((await viewerOffer(app, sessionId)).status).toBe(200);

      expect(sendCommandToAgentMock).toHaveBeenCalledTimes(2);
      expect((await readFence(sessionId)).generation).toBe(2n);
    });

    it('accepts a retry once the in-flight marker expired (the first viewer gave up waiting)', async () => {
      const { sessionId } = await seedViewer();
      const app = viewerApp();

      expect((await viewerOffer(app, sessionId)).status).toBe(200);
      // The row is unchanged — still connecting, unanswered — only the
      // viewer's answer budget has run out.
      await getRedis()!.del(desktopStartInFlightRedisKey(sessionId));
      expect((await viewerOffer(app, sessionId)).status).toBe(200);
      expect((await readFence(sessionId)).generation).toBe(2n);
    });

    it('accepts a retry when the first start never reached the agent', async () => {
      const { sessionId } = await seedViewer();
      const app = viewerApp();
      sendCommandToAgentMock.mockReturnValueOnce(false);

      expect((await viewerOffer(app, sessionId)).status).toBe(502);
      expect((await viewerOffer(app, sessionId)).status).toBe(200);
      expect((await readFence(sessionId)).generation).toBe(2n);
    });
  });

  it('formats generations as canonical decimal strings beyond 2^53', () => {
    // 2^53 + 1 has no float64 representation: the whole point of never letting
    // a generation pass through a JavaScript Number.
    const beyondFloatPrecision = 9007199254740993n;
    expect(formatDesktopGeneration(beyondFloatPrecision)).toBe('9007199254740993');
    expect(BigInt(Number(formatDesktopGeneration(beyondFloatPrecision)))).not.toBe(
      beyondFloatPrecision,
    );
  });
});
