import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { tunnelSessions, devices, users } from '../db/schema';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { captureException } from '../services/sentry';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { isViewerSessionRevoked, revokeViewerSession } from '../services/viewerTokenRevocation';
import { getTrustedClientIp } from '../services/clientIp';
import { createAuditLogAsync } from '../services/auditService';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import {
  bindRemoteConnection,
  installLocalRemoteConnection,
  ownsSafeRemoteConnection,
  removeExactLocalRemoteConnection,
  renewExactRemoteConnectionLease,
  type RemoteConnectionIdentity,
  type RemoteConnectionLease,
} from '../services/remoteWsOwnership';
import {
  getRemoteWsSharedLeaseManager,
  REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS,
  type RemoteWsSharedLeaseClaim,
  type RemoteWsSharedLeaseManager,
} from '../services/remoteWsSharedLease';
import { authorizeConsumedRemoteWsTicket } from '../services/remoteWsAuthorization';
import {
  assertRemoteWsUpgradeRuntimeReady,
  getRemoteWsUpgradeConnection,
  requireRemoteWsUpgrade,
  type RemoteWsUpgradeContext,
} from '../services/remoteWsUpgrade';

// Store active tunnel connections: Map<tunnelId, TunnelConnection>
interface TunnelConnection extends RemoteConnectionLease {
  sharedOwner: RemoteWsSharedLeaseClaim;
  sharedLeases: RemoteWsSharedLeaseManager;
  agentId: string;
  userId: string;
  deviceId: string;
  orgId: string;
  tunnelType: 'vnc' | 'proxy';
  startedAt: Date;
  pingInterval?: ReturnType<typeof setInterval>;
  leaseRenewalInterval?: ReturnType<typeof setInterval>;
  cleanupRetryTimeout?: ReturnType<typeof setTimeout>;
  lastPongAt: number;
}

const activeTunnelConnections = new Map<string, TunnelConnection>();

// Callback registry for tunnel data from agent: Map<tunnelId, callback>
type TunnelDataCallback = (data: Uint8Array) => void;
const tunnelDataCallbacks = new Map<string, TunnelDataCallback>();

// Tunnel ownership: tracks which agent owns each tunnel (populated on tunnel_open, before browser connects)
// Separate from activeTunnelConnections which is only populated when the browser WS attaches.
const tunnelAgentOwnership = new Map<string, string>(); // tunnelId → agentId

// Buffer for early frames: data arriving from agent before the browser WS connects.
// VNC servers send the RFB banner immediately on TCP connect, before the browser attaches.
const MAX_BUFFER_SIZE = 512 * 1024; // 512KB max buffer per tunnel
const MAX_TUNNEL_FRAME_BYTES = 1_000_000;
const MAX_TUNNEL_TEXT_MESSAGE_BYTES = Math.ceil(MAX_TUNNEL_FRAME_BYTES / 3) * 4 + 512;
const MAX_TUNNEL_BASE64_BYTES = Math.ceil(MAX_TUNNEL_FRAME_BYTES / 3) * 4;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const earlyFrameBuffers = new Map<string, Uint8Array[]>();

// Server-side ping/pong constants
const PING_INTERVAL_MS = 30_000;
// Generous tolerance: noVNC-driven tunnels have no JSON-level pong reply, so
// we rely on any inbound message (binary or text) as liveness. Backgrounded
// tabs can throttle client timers, so give the client up to ~2 minutes of
// silence before declaring the tunnel dead.
const PONG_TIMEOUT_MS = 90_000;
const TUNNEL_CLEANUP_RETRY_MS = 1_000;

// E1: Redis-backed sliding window rate limiter for user WS upgrades.
// Decision: fail closed on Redis outage (matches terminalWs/desktopWs).
const USER_WS_RATE_LIMIT = 10;
const USER_WS_RATE_WINDOW_SECONDS = 60;

export async function isUserTunnelWsRateLimited(userId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await rateLimiter(
    redis,
    `tunnelws:conn:${userId}`,
    USER_WS_RATE_LIMIT,
    USER_WS_RATE_WINDOW_SECONDS
  );
  return !result.allowed;
}

export function validateTunnelTextRelayFrame(text: string): { ok: true; data: string } | { ok: false; error: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_TUNNEL_TEXT_MESSAGE_BYTES) {
    return { ok: false, error: 'Text tunnel frame is too large' };
  }

  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, error: 'Invalid message' };
  }

  const record = msg as Record<string, unknown>;
  if (record.type !== 'data') {
    return { ok: false, error: 'Not data' };
  }

  if (typeof record.data !== 'string' || record.data.length === 0) {
    return { ok: false, error: 'Missing data' };
  }

  if (record.data.length > MAX_TUNNEL_BASE64_BYTES) {
    return { ok: false, error: 'Encoded tunnel frame is too large' };
  }

  if (!BASE64_RE.test(record.data)) {
    return { ok: false, error: 'Invalid base64 data' };
  }

  if (Buffer.byteLength(record.data, 'base64') > MAX_TUNNEL_FRAME_BYTES) {
    return { ok: false, error: 'Decoded tunnel frame is too large' };
  }

  return { ok: true, data: record.data };
}

/**
 * Register tunnel ownership (called when tunnel_open succeeds, before browser connects).
 */
export function registerTunnelOwnership(tunnelId: string, agentId: string): void {
  tunnelAgentOwnership.set(tunnelId, agentId);
  earlyFrameBuffers.set(tunnelId, []);
}

/**
 * Handle tunnel data arriving from the agent (binary 0x03 frames via agentWs).
 * Relays to browser WS if connected, otherwise buffers for later flush.
 */
export function handleTunnelDataFromAgent(tunnelId: string, data: Uint8Array): void {
  const callback = tunnelDataCallbacks.get(tunnelId);
  if (callback) {
    callback(data);
    return;
  }

  // Browser not connected yet — buffer early frames (e.g., VNC RFB banner).
  const buf = earlyFrameBuffers.get(tunnelId);
  if (buf) {
    const totalSize = buf.reduce((s, b) => s + b.length, 0) + data.length;
    if (totalSize <= MAX_BUFFER_SIZE) {
      buf.push(new Uint8Array(data));
    }
    // Silently drop if buffer is full — better than crashing.
  }
}

/**
 * Check if a tunnel is owned by a specific agent.
 * Uses the ownership map (populated on tunnel_open) rather than activeTunnelConnections
 * (which is only populated when the browser WS connects).
 */
export function isTunnelOwnedByAgent(tunnelId: string, agentId: string): boolean {
  const owner = tunnelAgentOwnership.get(tunnelId);
  if (owner) return owner === agentId;
  // Fallback to active connections for backwards compat
  const conn = activeTunnelConnections.get(tunnelId);
  if (!conn) return false;
  return conn.agentId === agentId;
}

/**
 * Validate one-time WS ticket and tunnel session access.
 */
async function validateTunnelAccess(
  tunnelId: string,
  ticket: string | undefined,
  caller: { ip: string; userAgent: string }
): Promise<{ valid: boolean; error?: string; session?: typeof tunnelSessions.$inferSelect; agentId?: string; userId?: string }> {
  if (!ticket) {
    return { valid: false, error: 'Missing connection ticket' };
  }

  const consumed = await consumeWsTicket(ticket, caller);
  if (!consumed.ok) {
    void createAuditLogAsync({
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000000',
      action: 'ws.ticket.rejected',
      resourceType: 'ws_ticket',
      resourceName: ticket.slice(0, 8),
      details: { reason: consumed.reason, sessionType: 'tunnel', tunnelId },
      ipAddress: caller.ip,
      userAgent: caller.userAgent,
      result: 'denied',
    });
    return { valid: false, error: 'Invalid or expired connection ticket' };
  }

  if (consumed.sessionId !== tunnelId || consumed.sessionType !== 'tunnel') {
    return { valid: false, error: 'Connection ticket does not match tunnel session' };
  }
  const ticketRecord = consumed;

  // Ticket consumption is the entire auth boundary for tunnel WS — the
  // WS routes mount before auth middleware. Run lookups in system DB
  // context so RLS doesn't fail-close the query. The session.userId ===
  // user.id check below enforces tenant scoping in app code.
  return withSystemDbAccessContext(async () => {
    // Check user exists and is active
    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, ticketRecord.userId))
      .limit(1);

    if (!user || user.status !== 'active') {
      return { valid: false, error: 'User not found or inactive' };
    }

    // Get tunnel session with device info
    const [result] = await db
      .select({
        session: tunnelSessions,
        device: devices
      })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .where(eq(tunnelSessions.id, tunnelId))
      .limit(1);

    if (!result) {
      return { valid: false, error: 'Tunnel session not found' };
    }

    const { session, device } = result;

    if (session.userId !== user.id) {
      return { valid: false, error: 'Tunnel session does not belong to this user' };
    }

    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return { valid: false, error: `Tunnel session is ${session.status}` };
    }

    if (device.status !== 'online') {
      return { valid: false, error: 'Device is not online' };
    }

    // Remote access policy enforcement (defense-in-depth)
    const tunnelCapability = session.type === 'vnc' ? 'vncRelay' as const : 'proxy' as const;
    const policyCheck = await checkRemoteAccess(device.id, tunnelCapability);
    if (!policyCheck.allowed) {
      return { valid: false, error: policyCheck.reason ?? 'Tunnel access disabled by policy' };
    }

    return { valid: true, session, agentId: device.agentId ?? undefined, userId: user.id };
  });
}

function cleanupTunnelConnection(tunnelId: string, expected?: TunnelConnection) {
  const conn = activeTunnelConnections.get(tunnelId);
  if (expected && conn !== expected) return;
  if (conn?.pingInterval) {
    clearInterval(conn.pingInterval);
  }
  if (conn?.leaseRenewalInterval) {
    clearInterval(conn.leaseRenewalInterval);
  }
  if (conn?.cleanupRetryTimeout) {
    clearTimeout(conn.cleanupRetryTimeout);
  }
  activeTunnelConnections.delete(tunnelId);
  tunnelDataCallbacks.delete(tunnelId);
  tunnelAgentOwnership.delete(tunnelId);
  earlyFrameBuffers.delete(tunnelId);
}

function closeTunnelLifecycle(
  tunnelId: string,
  options: {
    expectedWs: WSContext;
    connection: RemoteConnectionIdentity;
    notifyAgent: boolean;
    reason?: string;
  },
) {
  const conn = activeTunnelConnections.get(tunnelId);
  if (
    !conn
    || conn.userWs !== options.expectedWs
    || conn.connectionId !== options.connection.connectionId
    || conn.generation !== options.connection.generation
    || conn.instanceId !== options.connection.instanceId
    || conn.leaseToken !== options.connection.leaseToken
  ) {
    return Promise.resolve();
  }
  if (conn.cleanupPromise) return conn.cleanupPromise;
  if (conn.cleanupRetryTimeout) {
    clearTimeout(conn.cleanupRetryTimeout);
    conn.cleanupRetryTimeout = undefined;
  }
  conn.state = 'closing';
  conn.safeForwardingUntilMonotonicMs = 0;
  if (conn.pingInterval) clearInterval(conn.pingInterval);
  if (conn.leaseRenewalInterval) clearInterval(conn.leaseRenewalInterval);

  const cleanupAttempt = (async () => {
    const close = await conn.sharedLeases.beginClose(conn.sharedOwner);
    if (!close.ok && close.reason === 'owner_mismatch') {
      cleanupTunnelConnection(tunnelId, conn);
      return;
    }
    if (!close.ok) {
      // Forwarding must stop immediately, but the exact local record stays
      // installed so the same owner can retry beginClose.  Treating an
      // indeterminate Redis result as success would strand the shared lease
      // and its agent callback without a future teardown attempt.
      tunnelDataCallbacks.delete(tunnelId);
      earlyFrameBuffers.delete(tunnelId);
      try {
        conn.userWs?.close(1011, 'Tunnel ownership unavailable');
      } catch {
        // The retry below is still required if the socket is already gone.
      }
      throw new Error('Tunnel close ownership proof unavailable');
    }

    await withSystemDbAccessContext(async () => {
      await db
        .update(tunnelSessions)
        .set({
          status: 'disconnected',
          endedAt: new Date(),
          ...(options.reason ? { errorMessage: options.reason } : {}),
        })
        .where(and(
          eq(tunnelSessions.id, tunnelId),
          inArray(tunnelSessions.status, ['pending', 'connecting', 'active']),
        ));
    });
    await revokeViewerSession(tunnelId);
    tunnelDataCallbacks.delete(tunnelId);
    earlyFrameBuffers.delete(tunnelId);
    tunnelAgentOwnership.delete(tunnelId);
    if (options.notifyAgent) {
      sendCommandToAgent(conn.agentId, {
        id: `tun-close-${tunnelId}-${conn.generation}`,
        type: 'tunnel_close',
        payload: { tunnelId },
      });
    }
    removeExactLocalRemoteConnection(
      activeTunnelConnections,
      tunnelId,
      options.connection,
    );
    await conn.sharedLeases.release(conn.sharedOwner);
  })();
  const cleanup = cleanupAttempt.catch((error) => {
    if (activeTunnelConnections.get(tunnelId) === conn) {
      conn.cleanupPromise = undefined;
      conn.cleanupRetryTimeout = setTimeout(() => {
        conn.cleanupRetryTimeout = undefined;
        void closeTunnelLifecycle(tunnelId, options).catch(() => {
          // The lifecycle schedules the next exact retry while this same
          // closing connection remains installed.
        });
      }, TUNNEL_CLEANUP_RETRY_MS);
    }
    throw error;
  });
  conn.cleanupPromise = cleanup;
  return cleanup;
}

function closeTunnelInBackground(
  tunnelId: string,
  options: Parameters<typeof closeTunnelLifecycle>[1],
  trigger: 'relay_send' | 'pong_timeout' | 'ping_send' | 'lease_renewal',
): void {
  void closeTunnelLifecycle(tunnelId, options).catch(() => {
    console.error('[TunnelWs] cleanup retained for retry', {
      tunnelId: tunnelId.slice(0, 12),
      trigger,
    });
  });
}

/**
 * Mid-session revalidation: re-check that an active tunnel's user is still
 * active, still owns the session, the device is still online, and the
 * remote-access policy still permits the relay. Mirrors the connect-time
 * checks in `validateTunnelAccess` minus the one-time ticket (already
 * consumed). Returns `{ ok: false, reason }` when access has been revoked
 * so the caller can tear the socket down fail-closed.
 *
 * Ticket consumption is the only connect-time auth boundary for a tunnel WS,
 * and the user↔agent relay re-checks nothing once forwarding — so without
 * this a revoke (operator suspended, device offline/quarantined, policy
 * disabled, session ended elsewhere) keeps traffic flowing to the agent until
 * the pong timeout, or indefinitely while the client stays live.
 */
export async function revalidateTunnelSession(
  tunnelId: string,
  conn: Pick<TunnelConnection, 'userId' | 'deviceId' | 'tunnelType'>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, conn.userId))
      .limit(1);

    if (!user || user.status !== 'active') {
      return { ok: false as const, reason: 'User no longer active' };
    }

    const [result] = await db
      .select({ session: tunnelSessions, device: devices })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .where(eq(tunnelSessions.id, tunnelId))
      .limit(1);

    if (!result) {
      return { ok: false as const, reason: 'Tunnel session not found' };
    }

    const { session, device } = result;

    if (session.userId !== user.id) {
      return { ok: false as const, reason: 'Tunnel session no longer owned by user' };
    }

    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return { ok: false as const, reason: `Tunnel session is ${session.status}` };
    }

    if (device.status !== 'online') {
      return { ok: false as const, reason: 'Device is no longer online' };
    }

    const tunnelCapability = conn.tunnelType === 'vnc' ? 'vncRelay' as const : 'proxy' as const;
    const policyCheck = await checkRemoteAccess(device.id, tunnelCapability);
    if (!policyCheck.allowed) {
      return { ok: false as const, reason: policyCheck.reason ?? 'Tunnel access disabled by policy' };
    }

    return { ok: true as const };
  });
}

async function closeRevokedTunnelSocket(
  tunnelId: string,
  conn: TunnelConnection,
  ws: WSContext,
  lifecycleReason: string,
  socketReason: string,
): Promise<true> {
  await closeTunnelLifecycle(tunnelId, {
    expectedWs: ws,
    connection: conn,
    notifyAgent: true,
    reason: lifecycleReason,
  }).catch(() => {
    console.error('[TunnelWs] cleanup retained for retry', {
      tunnelId: tunnelId.slice(0, 12),
      trigger: 'revocation',
    });
  });
  try {
    ws.close(4003, socketReason);
  } catch {
    // The exact socket may already be closing; forwarding is inert.
  }
  return true;
}

/**
 * Mid-session revocation gate for a live tunnel socket. Combines the
 * cross-instance Redis revoke flag (`isViewerSessionRevoked`, set by
 * `revokeViewerSession` on teardown elsewhere) with the DB revalidation
 * above. Fails CLOSED: any thrown error or revoked/invalid state tears the
 * socket down so a revoked user/device cannot keep forwarding traffic.
 * Returns `true` when the socket was closed.
 */
export async function enforceTunnelRevocation(tunnelId: string, ws: WSContext): Promise<boolean> {
  const conn = activeTunnelConnections.get(tunnelId);
  if (
    !conn
    || conn.userWs !== ws
    || !ownsSafeRemoteConnection(activeTunnelConnections, tunnelId, conn, ws)
  ) return false;

  try {
    const revoked = await isViewerSessionRevoked(tunnelId);
    if (revoked) {
      console.warn(`[TunnelWs] Tunnel ${tunnelId} revoked mid-session, closing socket`);
      return closeRevokedTunnelSocket(
        tunnelId,
        conn,
        ws,
        'Tunnel revoked',
        'Tunnel revoked',
      );
    }

    const check = await revalidateTunnelSession(tunnelId, conn);
    if (!check.ok) {
      console.warn(`[TunnelWs] Tunnel ${tunnelId} access revoked mid-session (${check.reason}), closing socket`);
      return closeRevokedTunnelSocket(
        tunnelId,
        conn,
        ws,
        check.reason,
        'Access revoked',
      );
    }

    return false;
  } catch (err) {
    // Fail CLOSED: a thrown error (Redis down already resolves `true` above,
    // but a DB error here must not leave the tunnel relaying) tears the
    // socket down this tick.
    console.error(`[TunnelWs] Revocation check failed for tunnel ${tunnelId}, closing socket (fail-closed):`, err);
    return closeRevokedTunnelSocket(
      tunnelId,
      conn,
      ws,
      'Revocation check failed',
      'Revocation check failed',
    );
  }
}

/**
 * Test-only seam: register/clear an entry in the module-private
 * `activeTunnelConnections` map so unit tests can drive
 * `enforceTunnelRevocation` (which only acts on a registered connection)
 * without standing up the full `onOpen` validation flow. Not used by any
 * production code path.
 */
export function __setTunnelConnectionForTest(
  tunnelId: string,
  conn: (
    Omit<
      TunnelConnection,
      | 'connectionId'
      | 'generation'
      | 'instanceId'
      | 'leaseToken'
      | 'state'
      | 'safeForwardingUntilMonotonicMs'
      | 'sharedOwner'
      | 'sharedLeases'
    >
    & Partial<Pick<
      TunnelConnection,
      | 'connectionId'
      | 'generation'
      | 'instanceId'
      | 'leaseToken'
      | 'state'
      | 'safeForwardingUntilMonotonicMs'
      | 'sharedOwner'
      | 'sharedLeases'
    >>
  ) | undefined,
): void {
  if (conn) {
    const identity = {
      connectionId: conn.connectionId ?? '33333333-3333-4333-8333-333333333333',
      generation: conn.generation ?? 1,
      instanceId: conn.instanceId ?? '44444444-4444-4444-8444-444444444444',
      leaseToken: conn.leaseToken ?? '55555555-5555-4555-8555-555555555555',
    };
    const sharedOwner = conn.sharedOwner ?? {
      ...identity,
      kind: 'tunnel' as const,
      sessionId: tunnelId,
      ownerValue: 'test-tunnel-owner',
      safeForwardingUntilMonotonicMs: Number.MAX_SAFE_INTEGER,
    };
    activeTunnelConnections.set(tunnelId, {
      ...conn,
      ...identity,
      state: conn.state ?? 'active',
      safeForwardingUntilMonotonicMs:
        conn.safeForwardingUntilMonotonicMs ?? Number.MAX_SAFE_INTEGER,
      sharedOwner,
      sharedLeases: conn.sharedLeases ?? ({
        beginClose: async () => ({ ok: true, ownership: 'still_owner' }),
        release: async () => true,
      } as unknown as RemoteWsSharedLeaseManager),
    });
  } else {
    cleanupTunnelConnection(tunnelId);
  }
}

async function validateTunnelUpgradeContext(
  context: RemoteWsUpgradeContext,
): Promise<Awaited<ReturnType<typeof validateTunnelAccess>>> {
  const result = context.authorizationPhase === 'complete'
    ? { ok: true as const, context: context.authorization }
    : await authorizeConsumedRemoteWsTicket(context.ticket);
  if (!result.ok) return { valid: false, error: result.reason };
  const authorization = result.context;
  return {
    valid: true,
    userId: authorization.userId,
    agentId: authorization.agentId,
    session: {
      id: authorization.sessionId,
      type: authorization.tunnelType ?? 'proxy',
      userId: authorization.userId,
      deviceId: authorization.deviceId,
      orgId: authorization.orgId,
      status: 'pending',
    } as typeof tunnelSessions.$inferSelect,
  };
}

/**
 * Create WebSocket handlers for a tunnel session.
 */
function createTunnelWsHandlers(
  tunnelId: string,
  ticket: string | undefined,
  caller: { ip: string; userAgent: string },
  sharedLeases: RemoteWsSharedLeaseManager,
  upgradeContext?: RemoteWsUpgradeContext,
) {
  let validationResult: Awaited<ReturnType<typeof validateTunnelAccess>> | null = null;
  let connectionIdentity: RemoteConnectionIdentity | null = null;
  const validationPromise = (
    upgradeContext
      ? validateTunnelUpgradeContext(upgradeContext)
      : validateTunnelAccess(tunnelId, ticket, caller)
  ).then(result => {
    validationResult = result;
  });
  const releaseOpeningReservation = async () => {
    if (!upgradeContext) return;
    removeExactLocalRemoteConnection(
      activeTunnelConnections,
      tunnelId,
      getRemoteWsUpgradeConnection(upgradeContext),
    );
    upgradeContext.sharedClaim.safeForwardingUntilMonotonicMs = 0;
    await sharedLeases.release(upgradeContext.sharedClaim);
  };

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      try {
        await validationPromise;

        if (!validationResult || !validationResult.valid) {
          await releaseOpeningReservation();
          console.warn(`[TunnelWs] Rejected tunnel ${tunnelId}: ${validationResult?.error}`);
          ws.send(JSON.stringify({ type: 'error', message: validationResult?.error ?? 'Validation failed' }));
          ws.close(4001, validationResult?.error ?? 'Validation failed');
          return;
        }

        const { session, agentId, userId } = validationResult;
        if (!session || !agentId || !userId) {
          await releaseOpeningReservation();
          ws.close(4001, 'Missing session data');
          return;
        }

        if (!upgradeContext && await isUserTunnelWsRateLimited(userId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too many tunnel connections' }));
          ws.close(4029, 'Rate limited');
          return;
        }

        if (!isAgentConnected(agentId)) {
          await releaseOpeningReservation();
          ws.send(JSON.stringify({ type: 'error', message: 'Agent is not connected' }));
          ws.close(4002, 'Agent offline');
          return;
        }

        const acquired = upgradeContext
          ? { ok: true as const, claim: upgradeContext.sharedClaim }
          : await sharedLeases.acquire('tunnel', tunnelId);
        if (!acquired.ok) {
          ws.close(
            acquired.reason === 'already_owned' ? 4009 : 1011,
            'Tunnel ownership unavailable',
          );
          return;
        }
        connectionIdentity = {
          connectionId: acquired.claim.connectionId,
          generation: acquired.claim.generation,
          instanceId: acquired.claim.instanceId,
          leaseToken: acquired.claim.leaseToken,
        };
        const existingReservation = upgradeContext
          ? activeTunnelConnections.get(tunnelId)
          : undefined;
        const connection: TunnelConnection = existingReservation ?? {
          ...acquired.claim,
          state: 'opening' as const,
          userWs: null,
          sharedOwner: acquired.claim,
          sharedLeases,
          agentId,
          userId,
          deviceId: session.deviceId,
          orgId: session.orgId,
          tunnelType: session.type,
          startedAt: new Date(),
          lastPongAt: Date.now(),
        };
        if (existingReservation) {
          Object.assign(existingReservation, {
            agentId,
            userId,
            deviceId: session.deviceId,
            orgId: session.orgId,
            tunnelType: session.type,
            startedAt: new Date(),
            lastPongAt: Date.now(),
          });
        }
        const installed = upgradeContext
          ? (
              existingReservation
              && existingReservation.connectionId === acquired.claim.connectionId
              && existingReservation.generation === acquired.claim.generation
              && existingReservation.instanceId === acquired.claim.instanceId
              && existingReservation.leaseToken === acquired.claim.leaseToken
                ? { ok: true as const }
                : { ok: false as const, reason: 'already_owned' as const }
            )
          : installLocalRemoteConnection(
              activeTunnelConnections,
              tunnelId,
              acquired.claim,
              () => connection,
            );
        if (
          !installed.ok
          || !bindRemoteConnection(
            activeTunnelConnections,
            tunnelId,
            connectionIdentity,
            ws,
          )
        ) {
          removeExactLocalRemoteConnection(
            activeTunnelConnections,
            tunnelId,
            connectionIdentity,
          );
          await sharedLeases.release(acquired.claim);
          ws.close(4009, 'Tunnel already owned');
          return;
        }

        // Register data callback: agent data → user WebSocket
        tunnelDataCallbacks.set(tunnelId, (data: Uint8Array) => {
          if (
            !connectionIdentity
            || !ownsSafeRemoteConnection(
              activeTunnelConnections,
              tunnelId,
              connectionIdentity,
              ws,
            )
          ) return;
          try {
            ws.send(data as Uint8Array<ArrayBuffer>);
          } catch (err) {
            console.warn(`[TunnelWs] Failed to relay data for tunnel ${tunnelId}, cleaning up:`, err);
            closeTunnelInBackground(tunnelId, {
              expectedWs: ws,
              connection: connectionIdentity,
              notifyAgent: true,
              reason: 'Relay send failed',
            }, 'relay_send');
            try { ws.close(4005, 'Relay error'); } catch { /* already closing */ }
          }
        });

        // Flush any early frames buffered before the browser connected
        // (e.g., VNC RFB banner sent by the server on TCP connect).
        const buffered = earlyFrameBuffers.get(tunnelId);
        if (buffered && buffered.length > 0) {
          for (const frame of buffered) {
            if (
              !connectionIdentity
              || !ownsSafeRemoteConnection(
                activeTunnelConnections,
                tunnelId,
                connectionIdentity,
                ws,
              )
            ) {
              break;
            }
            try { ws.send(frame as Uint8Array<ArrayBuffer>); } catch { break; }
          }
        }
        earlyFrameBuffers.delete(tunnelId);

        // Server-side ping to detect stale connections
        connection.pingInterval = setInterval(() => {
          const conn = activeTunnelConnections.get(tunnelId);
          if (
            !conn
            || !connectionIdentity
            || !ownsSafeRemoteConnection(
              activeTunnelConnections,
              tunnelId,
              connectionIdentity,
              ws,
            )
          ) return;

          if (Date.now() - conn.lastPongAt > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
            console.warn(`[TunnelWs] Stale tunnel connection ${tunnelId}, closing`);
            closeTunnelInBackground(tunnelId, {
              expectedWs: ws,
              connection: connectionIdentity,
              notifyAgent: true,
              reason: 'Connection timeout',
            }, 'pong_timeout');
            ws.close(4003, 'Connection timeout');
            return;
          }

          // Mid-session revocation enforcement: re-check user/device/session/
          // policy on each ping interval and tear the socket down fail-closed
          // if access is gone. A revoked tunnel closes within at most one ping
          // interval (~PING_INTERVAL_MS). Nothing else re-checks authorization
          // once the relay is forwarding.
          void enforceTunnelRevocation(tunnelId, ws).then((closed) => {
            if (closed) return;
            if (
              !connectionIdentity
              || !ownsSafeRemoteConnection(
                activeTunnelConnections,
                tunnelId,
                connectionIdentity,
                ws,
              )
            ) return;
            try {
              ws.send(JSON.stringify({ type: 'ping' }));
            } catch {
              closeTunnelInBackground(tunnelId, {
                expectedWs: ws,
                connection: connectionIdentity!,
                notifyAgent: true,
                reason: 'Relay ping failed',
              }, 'ping_send');
            }
          });
        }, PING_INTERVAL_MS);
        connection.leaseRenewalInterval = setInterval(() => {
          if (!connectionIdentity) return;
          void renewExactRemoteConnectionLease(
            activeTunnelConnections,
            tunnelId,
            connectionIdentity,
            ws,
            () => sharedLeases.renew(connection.sharedOwner),
          ).then((renewed) => {
            if (!renewed && connectionIdentity) {
              closeTunnelInBackground(tunnelId, {
                expectedWs: ws,
                connection: connectionIdentity,
                notifyAgent: true,
                reason: 'Lease renewal failed',
              }, 'lease_renewal');
            }
          });
        }, REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS);

        // Only transition to active if the tunnel_open succeeded (status = connecting).
        // If the agent already failed, session.status will be 'failed' and we should not override.
        const currentSession = await withSystemDbAccessContext(async () => {
          const [row] = await db
            .select({ status: tunnelSessions.status })
            .from(tunnelSessions)
            .where(eq(tunnelSessions.id, tunnelId))
            .limit(1);
          return row ?? null;
        });

        if (!ownsSafeRemoteConnection(
          activeTunnelConnections,
          tunnelId,
          connectionIdentity,
          ws,
        )) {
          await closeTunnelLifecycle(tunnelId, {
            expectedWs: ws,
            connection: connectionIdentity,
            notifyAgent: true,
            reason: 'Tunnel ownership lost during setup',
          });
          return;
        }

        if (currentSession?.status === 'failed') {
          ws.send(JSON.stringify({ type: 'error', message: 'Tunnel failed to open on agent' }));
          await closeTunnelLifecycle(tunnelId, {
            expectedWs: ws,
            connection: connectionIdentity,
            notifyAgent: false,
            reason: 'Tunnel failed to open on agent',
          });
          ws.close(4004, 'Tunnel open failed');
          return;
        }

        const [activated] = await withSystemDbAccessContext(async () =>
          db
            .update(tunnelSessions)
            .set({ status: 'active', startedAt: new Date() })
            .where(and(
              eq(tunnelSessions.id, tunnelId),
              inArray(tunnelSessions.status, ['pending', 'connecting', 'active']),
            ))
            .returning({ id: tunnelSessions.id }),
        );
        if (
          !activated
          || !ownsSafeRemoteConnection(
            activeTunnelConnections,
            tunnelId,
            connectionIdentity,
            ws,
          )
        ) {
          await closeTunnelLifecycle(tunnelId, {
            expectedWs: ws,
            connection: connectionIdentity,
            notifyAgent: true,
            reason: 'Tunnel activation race',
          });
          return;
        }

        ws.send(JSON.stringify({ type: 'connected', tunnelId }));
      } catch (error) {
        console.error(`[TunnelWs] Error in onOpen for tunnel ${tunnelId}:`, error);
        captureException(error);
        if (connectionIdentity) {
          await closeTunnelLifecycle(tunnelId, {
            expectedWs: ws,
            connection: connectionIdentity,
            notifyAgent: true,
            reason: 'Tunnel setup failed',
          }).catch(() => undefined);
        } else {
          await releaseOpeningReservation();
        }
        ws.close(4000, 'Internal error');
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const conn = activeTunnelConnections.get(tunnelId);
      if (!conn) {
        ws.close(4001, 'No active tunnel connection');
        return;
      }
      if (
        !connectionIdentity
        || !ownsSafeRemoteConnection(
          activeTunnelConnections,
          tunnelId,
          connectionIdentity,
          ws,
        )
      ) return;

      // Any inbound message (binary or text) is liveness evidence — noVNC
      // consumes the WebSocket directly and never sees or replies to our JSON
      // ping/pong, but it does send incremental FramebufferUpdateRequests and
      // input events as binary frames. Treat every message as a keepalive.
      conn.lastPongAt = Date.now();

      try {
        // Binary data — relay directly to agent
        if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
          const buf = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;

          // Size limit: 1MB per frame
          if (buf.length > MAX_TUNNEL_FRAME_BYTES) {
            console.warn(`[TunnelWs] Dropping oversized user frame for tunnel ${tunnelId}: ${buf.length} bytes`);
            return;
          }

          const b64 = Buffer.from(buf).toString('base64');
          const sent = sendCommandToAgent(conn.agentId, {
            id: `tun-data-${Date.now()}`,
            type: 'tunnel_data',
            payload: { tunnelId, data: b64 },
          });
          if (!sent) {
            console.warn(`[TunnelWs] Agent ${conn.agentId} disconnected, cannot relay for tunnel ${tunnelId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Agent disconnected' }));
            await closeTunnelLifecycle(tunnelId, {
              expectedWs: ws,
              connection: connectionIdentity,
              notifyAgent: false,
              reason: 'Agent disconnected',
            });
            ws.close(4002, 'Agent offline');
            return;
          }
          return;
        }

        // Text data — JSON messages (ping/pong)
        const text = typeof event.data === 'string' ? event.data : event.data.toString();
        let msg: { type?: string } | null;
        try {
          const parsed = JSON.parse(text);
          msg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return; // Ignore malformed JSON
        }

        if (msg?.type === 'pong') {
          conn.lastPongAt = Date.now();
        } else if (msg?.type === 'data') {
          // Text-mode data relay (base64-encoded)
          const validated = validateTunnelTextRelayFrame(text);
          if (!validated.ok) {
            console.warn(`[TunnelWs] Dropping invalid text tunnel frame for tunnel ${tunnelId}: ${validated.error}`);
            return;
          }
          const sent = sendCommandToAgent(conn.agentId, {
            id: `tun-data-${Date.now()}`,
            type: 'tunnel_data',
            payload: { tunnelId, data: validated.data },
          });
          if (!sent) {
            console.warn(`[TunnelWs] Agent ${conn.agentId} disconnected, cannot relay for tunnel ${tunnelId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Agent disconnected' }));
            await closeTunnelLifecycle(tunnelId, {
              expectedWs: ws,
              connection: connectionIdentity,
              notifyAgent: false,
              reason: 'Agent disconnected',
            });
            ws.close(4002, 'Agent offline');
            return;
          }
        }
      } catch (error) {
        console.error(`[TunnelWs] Error handling message for tunnel ${tunnelId}:`, error);
        captureException(error);
      }
    },

    onClose: async (_event: unknown, ws: WSContext) => {
      console.log(`[TunnelWs] Tunnel ${tunnelId} WebSocket closed`);
      if (!connectionIdentity) return;
      await closeTunnelLifecycle(tunnelId, {
        expectedWs: ws,
        connection: connectionIdentity,
        notifyAgent: true,
      });
    },

    onError: async (error: unknown, ws: WSContext) => {
      console.error(`[TunnelWs] Error for tunnel ${tunnelId}:`, error);
      captureException(error);
      if (!connectionIdentity) return;
      await closeTunnelLifecycle(tunnelId, {
        expectedWs: ws,
        connection: connectionIdentity,
        notifyAgent: true,
        reason: error instanceof Error ? error.message : 'Tunnel WebSocket error',
      });
    },
  };
}

/**
 * Create tunnel WebSocket routes.
 * Pattern: GET /api/v1/tunnel-ws/:tunnelId/ws?ticket=xxx
 */
export function createTunnelWsRoutes(
  upgradeWebSocket: (createEvents: () => ReturnType<typeof createTunnelWsHandlers>) => any,
  options: { sharedLeases?: RemoteWsSharedLeaseManager } = {},
) {
  assertRemoteWsUpgradeRuntimeReady();
  const routes = new Hono();

  routes.get(
    '/:tunnelId/ws',
    async (c, next) => {
      const sharedLeases = options.sharedLeases ?? getRemoteWsSharedLeaseManager();
      if (!sharedLeases) {
        return c.json({ error: 'Remote ownership unavailable' }, 503);
      }
      return requireRemoteWsUpgrade({
        expectedType: 'tunnel',
        sharedLeases,
        installLocal: (tunnelId, claim) =>
          installLocalRemoteConnection(
            activeTunnelConnections,
            tunnelId,
            claim,
            (shared): TunnelConnection => ({
              ...shared,
              state: 'opening',
              userWs: null,
              sharedOwner: shared,
              sharedLeases,
              agentId: '',
              userId: '',
              deviceId: '',
              orgId: '',
              tunnelType: 'proxy',
              startedAt: new Date(),
              lastPongAt: Date.now(),
            }),
          ),
        removeLocal: (tunnelId, claim) =>
          removeExactLocalRemoteConnection(activeTunnelConnections, tunnelId, claim),
      })(c, next);
    },
    (c) => {
    const tunnelId = c.req.param('tunnelId');
    const ticket = c.req.query('ticket');

    if (!tunnelId) {
      return c.json({ error: 'Missing tunnelId' }, 400);
    }

    // Task 16: bind ticket consumption to issuer's IP + UA.
    const caller = {
      ip: getTrustedClientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    };
    const sharedLeases = options.sharedLeases ?? getRemoteWsSharedLeaseManager();
    if (!sharedLeases) {
      return c.json({ error: 'Remote ownership unavailable' }, 503);
    }

    const context = (c as unknown as { get?: (key: string) => unknown })
      .get?.('remoteWs') as RemoteWsUpgradeContext | undefined;
    const wsHandler = upgradeWebSocket(() =>
      createTunnelWsHandlers(tunnelId, ticket, caller, sharedLeases, context),
    );
    return wsHandler(c, c.req.raw);
    },
  );

  return routes;
}
