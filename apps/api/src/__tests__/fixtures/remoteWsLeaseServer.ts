/**
 * Wave 4 / Task 9 — lease-aware fixture server (CHILD PROCESS ENTRY POINT).
 *
 * WHY A REAL CHILD PROCESS
 * ------------------------
 * The plan forbids substituting two manager objects in one process, and it is
 * right to: `instanceId` is one `randomUUID()` per API-process boot
 * (`remoteWsSharedLease.ts`), the process-local `Map` registries in
 * `terminalWs.ts` / `desktopWs.ts` are module singletons, and the `db` pool is
 * opened at module-load time. Two managers inside one Vitest worker would
 * share all of that and prove nothing about cross-replica ownership. Each
 * instance of this file is `fork`ed as a genuinely separate OS process with
 * its own boot UUID, its own Redis connection, its own local registries and
 * its own HTTP listener.
 *
 * ENV CONTRACT — must already be set by the parent's `fork(..., { env })`
 * before this module's first import, because `../../db` opens its postgres
 * pool at module-load time:
 *   REDIS_URL, DATABASE_URL, DATABASE_URL_APP, NODE_ENV, JWT_SECRET,
 *   REMOTE_WS_AUTH_MODE, WS_TICKETS_REQUIRE_REDIS
 *
 * PROTOCOL
 * --------
 * On boot the child opens an HTTP listener on an ephemeral port (its own
 * "listener", as the plan requires) and announces
 * `{ ready: true, port, instanceId, pid }` over the IPC channel. Commands are
 * `POST /` with a JSON body `{ op, ... }`; every reply is JSON. `op:'shutdown'`
 * replies and then exits.
 *
 * The child never asserts. It reports observations; the parent
 * (`remote-ws-durability.integration.test.ts`) does all the asserting.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';

import {
  createRemoteWsSharedLeaseManager,
  getRemoteWsRedisKeys,
  type RemoteWsSharedLeaseClaim,
  type RemoteWsSharedLeaseManager,
} from '../../services/remoteWsSharedLease';
import {
  bindRemoteConnection,
  installLocalRemoteConnection,
  ownsSafeRemoteConnection,
  removeExactLocalRemoteConnection,
  renewExactRemoteConnectionLease,
  type RemoteConnectionLease,
  type RemoteWsKind,
} from '../../services/remoteWsOwnership';

// ---------------------------------------------------------------------------
// Boot identity
// ---------------------------------------------------------------------------

/** One boot UUID per OS process — the same shape production uses. */
const INSTANCE_ID = randomUUID();

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
  maxRetriesPerRequest: 2,
  // The partition scenario calls `redis.disconnect()`; without this ioredis
  // would silently heal the "partition" mid-assertion.
  retryStrategy: () => null,
  lazyConnect: false,
});

const leases: RemoteWsSharedLeaseManager = createRemoteWsSharedLeaseManager({
  redis,
  instanceId: INSTANCE_ID,
  requiredTopology: 'standalone-single-primary',
});

// ---------------------------------------------------------------------------
// Local registries (the same production helpers the routes use)
// ---------------------------------------------------------------------------

interface FixtureLease extends RemoteConnectionLease {
  kind: RemoteWsKind;
  sessionId: string;
}

/** One local map per kind, mirroring the per-route module singletons. */
const localSessions: Record<RemoteWsKind, Map<string, FixtureLease>> = {
  terminal: new Map(),
  desktop: new Map(),
  tunnel: new Map(),
};

/** Retained claims, keyed by slot, so a STALE claim can still be replayed. */
const claims = new Map<string, RemoteWsSharedLeaseClaim>();

/** Stand-in for the browser `WSContext` — only object identity matters. */
const sockets = new Map<string, object>();

/**
 * Everything this process pushed at an agent. `probeForward` only appends
 * when the REAL `ownsSafeRemoteConnection` gate says the socket may forward,
 * so an empty sink is meaningful evidence.
 */
const agentSink: Array<{ kind: RemoteWsKind; sessionId: string; payload: string }> = [];

function slotKey(kind: RemoteWsKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

function identityOf(claim: RemoteWsSharedLeaseClaim) {
  return {
    connectionId: claim.connectionId,
    generation: claim.generation,
    instanceId: claim.instanceId,
    leaseToken: claim.leaseToken,
  };
}

function publicClaim(claim: RemoteWsSharedLeaseClaim) {
  return {
    kind: claim.kind,
    sessionId: claim.sessionId,
    connectionId: claim.connectionId,
    generation: claim.generation,
    instanceId: claim.instanceId,
    leaseToken: claim.leaseToken,
    ownerValue: claim.ownerValue,
    safeForwardingUntilMonotonicMs: claim.safeForwardingUntilMonotonicMs,
  };
}

// ---------------------------------------------------------------------------
// Lazily loaded desktop route surface
// ---------------------------------------------------------------------------

/**
 * Loaded on first use only. Importing `desktopWs.ts` pulls in the BullMQ
 * finalization queue and the orphan-recovery service; processes that only
 * exercise the generic lease protocol should not pay for that.
 */
let desktopSurface: {
  request: (path: string, headers: Record<string, string>) => Promise<Response>;
  captured: Map<string, { connection: ReturnType<typeof identityOf> }>;
  close: typeof import('../../routes/desktopWs')['closeDesktopSessionLifecycle'];
  count: typeof import('../../routes/desktopWs')['getActiveDesktopSessionCount'];
} | null = null;

async function getDesktopSurface() {
  if (desktopSurface) return desktopSurface;
  const { Hono } = await import('hono');
  const desktopWs = await import('../../routes/desktopWs');
  const { getRemoteWsUpgradeConnection } = await import('../../services/remoteWsUpgrade');

  const captured = new Map<string, { connection: ReturnType<typeof identityOf> }>();

  // Stand-in for `@hono/node-ws`'s `upgradeWebSocket`: the real middleware has
  // already installed the local session and reserved the shared owner by the
  // time this runs, which is exactly the state the stale-cleanup scenario
  // needs. No socket is upgraded — the scenario is about ownership, not I/O.
  const fakeUpgrade = (_createEvents: unknown) => (c: {
    req: { param: (key: string) => string };
    get: (key: string) => unknown;
  }) => {
    const context = c.get('remoteWs') as Parameters<typeof getRemoteWsUpgradeConnection>[0];
    captured.set(c.req.param('id'), {
      connection: getRemoteWsUpgradeConnection(context),
    });
    return new Response('installed', { status: 200 });
  };

  const app = new Hono();
  app.route('/', desktopWs.createDesktopWsRoutes(fakeUpgrade, { sharedLeases: leases }));

  const surface = {
    request: async (path: string, headers: Record<string, string>) =>
      app.request(`http://fixture${path}`, { headers }),
    captured,
    close: desktopWs.closeDesktopSessionLifecycle,
    count: desktopWs.getActiveDesktopSessionCount,
  };
  desktopSurface = surface;
  return surface;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Command = Record<string, unknown> & { op: string };

async function handle(command: Command): Promise<unknown> {
  const kind = command.kind as RemoteWsKind;
  const sessionId = command.sessionId as string;
  const key = kind && sessionId ? slotKey(kind, sessionId) : '';

  switch (command.op) {
    case 'identity':
      return { instanceId: INSTANCE_ID, pid: process.pid };

    case 'acquire': {
      const wallStartMs = Date.now();
      const result = await leases.acquire(kind, sessionId);
      if (!result.ok) {
        return { ok: false, reason: result.reason, wallStartMs, wallEndMs: Date.now() };
      }
      claims.set(key, result.claim);
      return {
        ok: true,
        claim: publicClaim(result.claim),
        monotonicNowMs: performance.now(),
        wallStartMs,
        wallEndMs: Date.now(),
      };
    }

    /** Raw `manager.renew` — used to prove a STALE claim cannot renew. */
    case 'renew': {
      const claim = claims.get(key);
      if (!claim) return { ok: false, reason: 'no_claim' };
      try {
        const renewed = await leases.renew(claim);
        return {
          ok: true,
          safeForwardingUntilMonotonicMs: renewed.safeForwardingUntilMonotonicMs,
          monotonicNowMs: performance.now(),
        };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'unknown',
          // Renewal expires forwarding BEFORE it does any I/O; report the
          // post-failure value so the parent can prove it.
          safeForwardingUntilMonotonicMs: claim.safeForwardingUntilMonotonicMs,
        };
      }
    }

    case 'beginClose': {
      const claim = claims.get(key);
      if (!claim) return { ok: false, reason: 'no_claim' };
      return leases.beginClose(claim);
    }

    case 'release': {
      const claim = claims.get(key);
      if (!claim) return { ok: false, reason: 'no_claim' };
      const released = await leases.release(claim);
      // The claim is deliberately RETAINED so the parent can replay it as a
      // stale claim afterwards.
      return { ok: released };
    }

    /** Install the local registry entry and bind a socket — production helpers. */
    case 'installAndBind': {
      const claim = claims.get(key);
      if (!claim) return { ok: false, reason: 'no_claim' };
      const installed = installLocalRemoteConnection(
        localSessions[kind],
        sessionId,
        claim,
        (shared): FixtureLease => ({
          kind,
          sessionId,
          connectionId: shared.connectionId,
          generation: shared.generation,
          instanceId: shared.instanceId,
          leaseToken: shared.leaseToken,
          state: 'opening',
          userWs: null,
          safeForwardingUntilMonotonicMs: shared.safeForwardingUntilMonotonicMs,
        }),
      );
      if (!installed.ok) return { ok: false, reason: installed.reason };
      const socket = {};
      sockets.set(key, socket);
      const bound = bindRemoteConnection(
        localSessions[kind],
        sessionId,
        identityOf(claim),
        socket as never,
      );
      return { ok: bound };
    }

    /**
     * The exact gate every event/callback/timer must pass in production. Only
     * a `true` result appends to the agent sink.
     */
    case 'probeForward': {
      const claim = claims.get(key);
      const socket = sockets.get(key);
      if (!claim || !socket) return { forwarded: false, reason: 'no_local_entry' };
      const allowed = ownsSafeRemoteConnection(
        localSessions[kind],
        sessionId,
        identityOf(claim),
        socket as never,
      );
      if (allowed) {
        agentSink.push({
          kind,
          sessionId,
          payload: String(command.payload ?? 'probe'),
        });
      }
      const entry = localSessions[kind].get(sessionId);
      return {
        forwarded: allowed,
        monotonicNowMs: performance.now(),
        safeForwardingUntilMonotonicMs: entry?.safeForwardingUntilMonotonicMs ?? null,
        agentSinkSize: agentSink.length,
      };
    }

    /**
     * Block the event loop synchronously for `ms`, then probe. This is the
     * faithful model of a long GC/CPU stall: no timer, no renewal and no
     * cleanup can run while it is blocked, yet the Redis key is still alive.
     */
    case 'blockThenProbe': {
      const ms = Number(command.ms ?? 0);
      const before = performance.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const after = performance.now();
      const probe = await handle({ op: 'probeForward', kind, sessionId });
      return { blockedForMs: after - before, ...(probe as object) };
    }

    /** The real production renewal path, local entry included. */
    case 'renewLocal': {
      const claim = claims.get(key);
      const socket = sockets.get(key) ?? null;
      if (!claim) return { ok: false, reason: 'no_claim' };
      const ok = await renewExactRemoteConnectionLease(
        localSessions[kind],
        sessionId,
        identityOf(claim),
        socket as never,
        () => leases.renew(claim),
      );
      const entry = localSessions[kind].get(sessionId);
      return {
        ok,
        stillInstalled: entry !== undefined,
        state: entry?.state ?? null,
        safeForwardingUntilMonotonicMs: entry?.safeForwardingUntilMonotonicMs ?? null,
        monotonicNowMs: performance.now(),
      };
    }

    /** Sever this process's Redis connection without letting ioredis heal it. */
    case 'partition': {
      redis.disconnect();
      return { ok: true, status: redis.status };
    }

    case 'localState': {
      const entry = localSessions[kind].get(sessionId);
      return {
        installed: entry !== undefined,
        state: entry?.state ?? null,
        safeForwardingUntilMonotonicMs: entry?.safeForwardingUntilMonotonicMs ?? null,
        monotonicNowMs: performance.now(),
      };
    }

    case 'removeLocal': {
      const claim = claims.get(key);
      if (!claim) return { ok: false, reason: 'no_claim' };
      return {
        ok: removeExactLocalRemoteConnection(
          localSessions[kind],
          sessionId,
          identityOf(claim),
        ),
      };
    }

    case 'agentSink':
      return { entries: agentSink };

    case 'redisKeys': {
      const keys = getRemoteWsRedisKeys(kind, sessionId);
      return { keys };
    }

    // -- desktop-specific ---------------------------------------------------

    /**
     * Drive the REAL desktop pre-upgrade middleware. On success the module's
     * own `activeDesktopSessions` map holds an exact entry built from a real
     * shared claim — the state the stale-cleanup scenario needs.
     */
    case 'desktopAdmit': {
      const surface = await getDesktopSurface();
      const response = await surface.request(
        `/${sessionId}/ws?ticket=${encodeURIComponent(String(command.ticket))}`,
        { 'user-agent': 'breeze-lease-fixture/1.0' },
      );
      const captured = surface.captured.get(sessionId) ?? null;
      return {
        status: response.status,
        body: await response.text(),
        connection: captured?.connection ?? null,
        activeDesktopSessions: surface.count(),
      };
    }

    /** Drive the REAL `closeDesktopSessionLifecycle`. */
    case 'desktopClose': {
      const surface = await getDesktopSurface();
      const captured = surface.captured.get(sessionId);
      if (!captured) return { settled: 'missing_connection' };
      try {
        await surface.close(sessionId, {
          // The entry is still `opening`, so its `userWs` is null and the
          // exact-socket check is satisfied by passing null.
          expectedWs: null as never,
          connection: captured.connection,
          reason: 'client_close',
          terminalStatus: 'disconnected',
          notifyAgent: false,
        });
        return { settled: 'resolved', activeDesktopSessions: surface.count() };
      } catch (error) {
        return {
          settled: 'rejected',
          error: error instanceof Error ? error.message : 'unknown',
          activeDesktopSessions: surface.count(),
        };
      }
    }

    /**
     * The REAL write-ahead intent persistence, driven with a fully valid
     * finalization payload. Used as the differential control for
     * "no finalization against the replacement".
     */
    case 'persistIntent': {
      const claim = claims.get(slotKey('desktop', sessionId));
      if (!claim) return { ok: false, reason: 'no_claim' };
      const { persistDesktopFinalizationIntent } = await import(
        '../../services/desktopSessionFinalization'
      );
      try {
        const persisted = await persistDesktopFinalizationIntent({
          finalization: {
            version: 1,
            finalizationId: String(command.finalizationId),
            sessionId,
            connection: identityOf(claim),
            orgId: String(command.orgId),
            userId: String(command.userId),
            deviceId: String(command.deviceId),
            reason: 'client_close',
            terminalStatus: 'disconnected',
            endedAt: new Date().toISOString(),
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            inputEvents: 0,
            frameBytes: 0,
          },
          sharedOwner: claim,
          sharedLeases: leases,
        });
        return { ok: true, canonicalPayload: persisted.canonicalPayload };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'unknown' };
      }
    }

    /**
     * The REAL durable agent-stop path. Used ONLY as a positive control, to
     * prove the parent's "no agent stop was emitted" query would actually see
     * a stop if one had been emitted.
     */
    case 'ensureStop': {
      const { ensureDesktopStreamStopped } = await import('../../services/desktopSessionStop');
      try {
        const proof = await ensureDesktopStreamStopped({
          version: 1,
          finalizationId: String(command.finalizationId),
          sessionId,
          connection: {
            connectionId: String(command.finalizationId),
            generation: 1,
            instanceId: String(command.finalizationId),
            leaseToken: String(command.finalizationId),
          },
          orgId: String(command.orgId),
          userId: String(command.userId),
          deviceId: String(command.deviceId),
          reason: 'client_close',
          terminalStatus: 'disconnected',
          endedAt: new Date().toISOString(),
          startedAt: new Date(Date.now() - 1_000).toISOString(),
          inputEvents: 0,
          frameBytes: 0,
        });
        return { ok: true, state: proof.state, commandId: proof.commandId };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'unknown' };
      }
    }

    case 'shutdown':
      return { ok: true };

    default:
      return { error: `unknown op ${String(command.op)}` };
  }
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    void (async () => {
      let command: Command;
      try {
        command = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Command;
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'bad json' }));
        return;
      }
      let payload: unknown;
      try {
        payload = await handle(command);
      } catch (error) {
        payload = { error: error instanceof Error ? error.message : 'unknown' };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
      if (command.op === 'shutdown') {
        // Hard exit: the postgres pool, BullMQ queue and ioredis client all
        // keep handles open; the parent already has its answer.
        setTimeout(() => process.exit(0), 25);
      }
    })();
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address() as AddressInfo;
  process.send?.({ ready: true, port: address.port, instanceId: INSTANCE_ID, pid: process.pid });
});
