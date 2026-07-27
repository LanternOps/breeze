import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { remoteSessions, devices, users } from '../db/schema';
import {
  createViewerAccessToken,
  verifyViewerAccessToken,
  type ViewerTokenPayload,
} from '../services/jwt';
import {
  createLegacyViewerCompatibilityWsTicket,
  createWsTicket,
  consumeDesktopConnectCode,
  consumeWsTicket,
  getViewerAccessTokenExpirySeconds,
} from '../services/remoteSessionAuth';
import { getIceServers, logSessionAudit, buildRemoteSessionPromptPayload } from './remote/helpers';
import { webrtcOfferSchema } from './remote/schemas';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { checkRemoteAccess, resolveDesktopSessionPolicy } from '../services/remoteAccessPolicy';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp } from '../services/clientIp';
import { isViewerJtiRevoked, isViewerSessionRevoked, revokeViewerSession } from '../services/viewerTokenRevocation';
import { createAuditLogAsync } from '../services/auditService';
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
import {
  finalizeDesktopSessionOnce,
  persistDesktopFinalizationIntent,
  releaseDesktopFinalizationIntent,
  type DesktopSessionFinalizationInput,
  type PersistedDesktopFinalizationIntent,
} from '../services/desktopSessionFinalization';
import { enqueueDesktopSessionFinalization } from '../jobs/desktopSessionFinalizationWorker';
import { ensureDesktopStreamStopped } from '../services/desktopSessionStop';
import { authorizeConsumedRemoteWsTicket } from '../services/remoteWsAuthorization';
import {
  assertRemoteWsUpgradeRuntimeReady,
  getRemoteWsUpgradeConnection,
  requireRemoteWsUpgrade,
  type RemoteWsUpgradeContext,
} from '../services/remoteWsUpgrade';

// Zod validation for desktop user messages
const desktopInputEvent = z.object({
  type: z.enum(['mousemove', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel', 'click', 'dblclick', 'mouse_move', 'mouse_down', 'mouse_up', 'key_down', 'key_up']),
  x: z.number().min(-10000).max(100000).optional(),
  y: z.number().min(-10000).max(100000).optional(),
  button: z.union([z.string().max(20), z.number().int().min(0).max(4)]).optional(),
  key: z.string().max(50).optional(),
  modifiers: z.union([
    z.array(z.string().max(20)).max(4),
    z.object({
      ctrl: z.boolean().optional(),
      alt: z.boolean().optional(),
      shift: z.boolean().optional(),
      meta: z.boolean().optional(),
    }),
  ]).optional(),
  delta: z.number().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  code: z.string().max(50).optional(),
});

const desktopMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), event: desktopInputEvent }),
  z.object({
    type: z.literal('config'),
    quality: z.number().int().min(1).max(100).optional(),
    scaleFactor: z.number().min(0.1).max(2).optional(),
    maxFps: z.number().int().min(1).max(60).optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);

// Store active desktop sessions
interface DesktopSession extends RemoteConnectionLease {
  sharedOwner: RemoteWsSharedLeaseClaim;
  sharedLeases: RemoteWsSharedLeaseManager;
  agentId: string;
  userId: string;
  deviceId: string;
  orgId: string;
  startedAt: Date;
  pingInterval?: ReturnType<typeof setInterval>;
  leaseRenewalInterval?: ReturnType<typeof setInterval>;
  cleanupRetryTimeout?: ReturnType<typeof setTimeout>;
  lastPongAt: number;
  // E2: token-bucket for input events (60 events/sec).
  inputTokens: number;
  inputLastRefillMs: number;
  inputOverageLogged: boolean;
  // E2: audit summary counters
  inputEvents: number;
  frameBytes: number;
  detachComplete: boolean;
  stopCommandId?: string;
  stopConfirmed: boolean;
  intentAcknowledged: boolean;
  finalizationInput?: DesktopSessionFinalizationInput;
  persistedIntent?: PersistedDesktopFinalizationIntent;
}

// E2: desktop input event token bucket (60 events/sec/session).
const DESKTOP_INPUT_TOKENS_PER_SEC = 60;
const DESKTOP_INPUT_BUCKET_CAPACITY = 60;

const activeDesktopSessions = new Map<string, DesktopSession>();

// Store frame callbacks — called by agentWs when binary frames arrive
type DesktopFrameCallback = (data: Uint8Array) => void;
const desktopFrameCallbacks = new Map<string, DesktopFrameCallback>();

// Server-side ping/pong constants for stale connection detection
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const DESKTOP_CLEANUP_RETRY_MS = 1_000;

// E1: Redis-backed sliding window rate limiter for user WS upgrades.
// Decision: fail closed on Redis outage (matches `rateLimiter` helper default).
// Rationale: viewer/operator-initiated WS — users can retry; an open door
// during a Redis blip is a bigger risk than a temporary 4029.
const USER_WS_RATE_LIMIT = 10;
const USER_WS_RATE_WINDOW_SECONDS = 60;

async function isUserDesktopWsRateLimited(userId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await rateLimiter(
    redis,
    `desktopws:conn:${userId}`,
    USER_WS_RATE_LIMIT,
    USER_WS_RATE_WINDOW_SECONDS
  );
  return !result.allowed;
}

async function revokeDesktopViewerSession(sessionId: string): Promise<void> {
  try {
    await revokeViewerSession(sessionId);
  } catch (error) {
    console.error(`[DesktopWs] Failed to revoke viewer tokens for session ${sessionId}:`, error);
  }
}

const desktopConnectExchangeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1)
});

const desktopSessionIdParamSchema = z.object({
  id: z.string().guid()
});

type ViewerAccessResult =
  | {
      valid: true;
      session: typeof remoteSessions.$inferSelect;
      device: typeof devices.$inferSelect;
      user: Pick<typeof users.$inferSelect, 'id' | 'email' | 'status'>;
      viewerToken: ViewerTokenPayload;
    }
  | {
      valid: false;
      status: 400 | 401 | 403 | 404;
      error: string;
    };

async function validateViewerSessionAccess(
  authorizationHeader: string | undefined,
  sessionId: string,
  prevalidatedViewerToken?: ViewerTokenPayload,
): Promise<ViewerAccessResult> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return { valid: false, status: 401, error: 'Missing viewer token' };
  }

  const token = authorizationHeader.slice(7);
  const payload = prevalidatedViewerToken ?? await verifyViewerAccessToken(token);
  if (!payload) {
    return { valid: false, status: 401, error: 'Invalid or expired viewer token' };
  }

  if (await isViewerJtiRevoked(payload.jti)) {
    return { valid: false, status: 401, error: 'Viewer token revoked' };
  }

  if (await isViewerSessionRevoked(payload.sessionId)) {
    return { valid: false, status: 401, error: 'Session closed' };
  }

  if (payload.sessionId !== sessionId) {
    return { valid: false, status: 403, error: 'Viewer token does not match session' };
  }

  // Viewer auth bypasses JWT middleware so no RLS context is set.
  // Use system scope — the viewer token already verified ownership.
  return withSystemDbAccessContext(async () => {
    const [result] = await db
      .select({
        session: remoteSessions,
        device: devices,
        user: {
          id: users.id,
          email: users.email,
          status: users.status,
        },
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .innerJoin(users, eq(remoteSessions.userId, users.id))
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);

    if (!result) {
      return { valid: false as const, status: 404 as const, error: 'Session not found' };
    }

    const { session, device, user } = result;

    if (session.type !== 'desktop') {
      return { valid: false as const, status: 400 as const, error: 'Session is not a desktop session' };
    }

    if (session.userId !== payload.sub || user.id !== payload.sub || user.email !== payload.email) {
      return { valid: false as const, status: 403 as const, error: 'Viewer token does not match session owner' };
    }

    if (user.status !== 'active') {
      return { valid: false as const, status: 403 as const, error: 'User not found or inactive' };
    }

    // Do not let a still-valid viewer token re-attach to a session that has
    // already ended. A 'disconnected'/'failed' row requires a freshly created
    // session to reconnect; otherwise a lingering viewer token (valid for up to
    // the viewer-token TTL, see getViewerAccessTokenExpirySeconds()) resurrects
    // a session the operator believes is over. Finding #5.
    if (session.status === 'disconnected' || session.status === 'failed') {
      return { valid: false as const, status: 401 as const, error: 'Session ended' };
    }

    // Re-enforce the remote-access policy on every viewer entry point, not just
    // at session creation: disabling webrtcDesktop mid-session must stop a
    // holder of an existing viewer token from (re)starting a stream. Finding #1.
    const policyCheck = await checkRemoteAccess(device.id, 'webrtcDesktop');
    if (!policyCheck.allowed) {
      return {
        valid: false as const,
        status: 403 as const,
        error: policyCheck.reason ?? 'Remote desktop is disabled by policy',
      };
    }

    return { valid: true as const, session, device, user, viewerToken: payload };
  });
}

/**
 * Validate one-time WS ticket and desktop session access
 */
async function validateDesktopAccess(
  sessionId: string,
  ticket: string | undefined,
  caller: { ip: string; userAgent: string }
): Promise<{ valid: boolean; error?: string; session?: typeof remoteSessions.$inferSelect; device?: typeof devices.$inferSelect; userId?: string }> {
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
      details: { reason: consumed.reason, sessionType: 'desktop', sessionId },
      ipAddress: caller.ip,
      userAgent: caller.userAgent,
      result: 'denied',
    });
    return { valid: false, error: 'Invalid or expired connection ticket' };
  }

  if (consumed.sessionId !== sessionId || consumed.sessionType !== 'desktop') {
    return { valid: false, error: 'Connection ticket does not match desktop session' };
  }
  const ticketRecord = consumed;

  // WS ticket auth bypasses JWT middleware so no RLS context is set.
  // Use system scope — the ticket already verified ownership.
  return withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, ticketRecord.userId))
      .limit(1);

    if (!user || user.status !== 'active') {
      return { valid: false, error: 'User not found or inactive' };
    }

    const [result] = await db
      .select({
        session: remoteSessions,
        device: devices
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);

    if (!result) {
      return { valid: false, error: 'Session not found' };
    }

    const { session, device } = result;

    if (session.type !== 'desktop') {
      return { valid: false, error: 'Session is not a desktop session' };
    }

    if (session.userId !== user.id) {
      return { valid: false, error: 'Session does not belong to this user' };
    }

    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return { valid: false, error: `Session is ${session.status}` };
    }

    if (device.status !== 'online') {
      return { valid: false, error: 'Device is not online' };
    }

    // Remote access policy enforcement (defense-in-depth)
    const policyCheck = await checkRemoteAccess(device.id, 'webrtcDesktop');
    if (!policyCheck.allowed) {
      return { valid: false, error: policyCheck.reason ?? 'Remote desktop disabled by policy' };
    }

    return { valid: true, session, device, userId: user.id };
  });
}

/**
 * Handle a desktop frame from the agent (binary JPEG data).
 * Called by the agentWs binary fast-path.
 */
export function handleDesktopFrame(sessionId: string, data: Uint8Array): void {
  const callback = desktopFrameCallbacks.get(sessionId);
  if (callback) {
    callback(data);
  }
}

/**
 * Register a callback for desktop frames
 */
export function registerDesktopFrameCallback(sessionId: string, callback: DesktopFrameCallback): void {
  desktopFrameCallbacks.set(sessionId, callback);
}

/**
 * Unregister desktop frame callback
 */
export function unregisterDesktopFrameCallback(sessionId: string): void {
  desktopFrameCallbacks.delete(sessionId);
}

function exactDesktopIdentity(
  session: DesktopSession,
  identity: RemoteConnectionIdentity,
): boolean {
  return (
    session.connectionId === identity.connectionId
    && session.generation === identity.generation
    && session.instanceId === identity.instanceId
    && session.leaseToken === identity.leaseToken
  );
}

function detachExactDesktopSession(
  sessionId: string,
  session: DesktopSession,
  reason: 'client_close' | 'socket_error' | 'pong_timeout' | 'revoked' | 'setup_failed',
): void {
  if (session.detachComplete) return;
  if (session.pingInterval) clearInterval(session.pingInterval);
  if (session.leaseRenewalInterval) clearInterval(session.leaseRenewalInterval);
  const current = activeDesktopSessions.get(sessionId);
  if (current !== session || !exactDesktopIdentity(current, session)) return;
  unregisterDesktopFrameCallback(sessionId);
  session.detachComplete = true;
  try {
    if (reason === 'revoked') {
      session.userWs?.close(4003, 'Session revoked');
    } else if (reason === 'pong_timeout') {
      session.userWs?.close(4008, 'Pong timeout');
    } else if (reason === 'socket_error') {
      session.userWs?.close(1011, 'Desktop session closing');
    }
  } catch {
    // The exact socket may already be closing. Forwarding and callbacks are
    // inert regardless, and durable stop/finalization must still continue.
  }
}

export function closeDesktopSessionLifecycle(
  sessionId: string,
  options: {
    expectedWs: WSContext;
    connection: RemoteConnectionIdentity;
    reason: 'client_close' | 'socket_error' | 'pong_timeout' | 'revoked' | 'setup_failed';
    terminalStatus: 'disconnected' | 'failed';
    notifyAgent: boolean;
  },
): Promise<void> {
  const session = activeDesktopSessions.get(sessionId);
  if (
    !session
    || session.userWs !== options.expectedWs
    || !exactDesktopIdentity(session, options.connection)
  ) {
    return Promise.resolve();
  }
  if (session.cleanupPromise) return session.cleanupPromise;
  if (session.cleanupRetryTimeout) {
    clearTimeout(session.cleanupRetryTimeout);
    session.cleanupRetryTimeout = undefined;
  }

  // Everything below this point is synchronous through promise publication.
  // No callback can forward after observing closing/deadline zero.
  session.state = 'closing';
  session.safeForwardingUntilMonotonicMs = 0;
  if (session.pingInterval) clearInterval(session.pingInterval);
  if (session.leaseRenewalInterval) clearInterval(session.leaseRenewalInterval);
  const endedAt = new Date();
  const finalizationInput: DesktopSessionFinalizationInput =
    session.finalizationInput ?? Object.freeze({
      version: 1,
      finalizationId: randomUUID(),
      sessionId,
      connection: Object.freeze({ ...options.connection }),
      orgId: session.orgId,
      userId: session.userId,
      deviceId: session.deviceId,
      reason: options.reason,
      terminalStatus: options.terminalStatus,
      endedAt: endedAt.toISOString(),
      startedAt: session.startedAt.toISOString(),
      inputEvents: Math.max(0, session.inputEvents),
      frameBytes: Math.max(0, session.frameBytes),
    });
  session.finalizationInput = finalizationInput;
  session.stopCommandId = finalizationInput.finalizationId;

  const cleanupAttempt = (async () => {
    const closeProof = await session.sharedLeases.beginClose(session.sharedOwner);
    if (!closeProof.ok && closeProof.reason === 'owner_mismatch') {
      // A replacement owns Redis. Only detach this exact stale local socket.
      detachExactDesktopSession(sessionId, session, options.reason);
      removeExactLocalRemoteConnection(activeDesktopSessions, sessionId, options.connection);
      return;
    }

    if (!closeProof.ok) {
      // Safety beats bookkeeping on coordination loss: detach and issue the
      // stable stop, but never finalize or release without persisted intent.
      detachExactDesktopSession(sessionId, session, options.reason);
      await ensureDesktopStreamStopped(finalizationInput).catch((error) => {
        console.error('[DesktopWs] safety stop attempt failed', {
          sessionId: sessionId.slice(0, 12),
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
      throw new Error('desktop close ownership proof unavailable');
    }

    let persisted: PersistedDesktopFinalizationIntent;
    try {
      persisted = await persistDesktopFinalizationIntent({
        finalization: finalizationInput,
        sharedOwner: session.sharedOwner,
        sharedLeases: session.sharedLeases,
      });
      session.persistedIntent = persisted;
      session.intentAcknowledged = true;
    } catch (error) {
      detachExactDesktopSession(sessionId, session, options.reason);
      await ensureDesktopStreamStopped(finalizationInput).catch(() => undefined);
      throw error;
    }

    // DELETE-LAST: callback/socket detachment follows acknowledged write-ahead.
    detachExactDesktopSession(sessionId, session, options.reason);

    try {
      const result = await finalizeDesktopSessionOnce(finalizationInput);
      if (result === 'finalized' || result === 'already_finalized') {
        session.stopConfirmed = true;
        const releasedIntent = await session.sharedLeases.releaseDesktopFinalizationIntent(
          sessionId,
          finalizationInput.finalizationId,
          persisted.canonicalPayload,
        );
        if (!releasedIntent) throw new Error('desktop finalization intent release failed');
        if (activeDesktopSessions.get(sessionId) === session) {
          removeExactLocalRemoteConnection(activeDesktopSessions, sessionId, options.connection);
        }
        await session.sharedLeases.release(session.sharedOwner);
        return;
      }
      throw new Error('desktop finalization stop pending');
    } catch (inlineError) {
      try {
        await enqueueDesktopSessionFinalization({
          sessionId,
          finalizationId: finalizationInput.finalizationId,
        });
      } catch {
        // Retain the exact inert owner + intent. A matching retry reuses this
        // cleanup promise/identity; no unconditional finally releases it.
        throw inlineError;
      }
      if (activeDesktopSessions.get(sessionId) === session) {
        removeExactLocalRemoteConnection(activeDesktopSessions, sessionId, options.connection);
      }
      await session.sharedLeases.release(session.sharedOwner);
    }
  })();
  const cleanup = cleanupAttempt.catch((error) => {
    // All concurrent callers shared this attempt. Once it fails, the same
    // inert owner can retry with the frozen payload and stable stop identity.
    if (activeDesktopSessions.get(sessionId) === session) {
      session.cleanupPromise = undefined;
      session.cleanupRetryTimeout = setTimeout(() => {
        session.cleanupRetryTimeout = undefined;
        void closeDesktopSessionLifecycle(sessionId, options).catch(() => {
          // The lifecycle schedules the next exact retry while the same inert
          // closing entry remains installed.
        });
      }, DESKTOP_CLEANUP_RETRY_MS);
    }
    throw error;
  });
  session.cleanupPromise = cleanup;
  return cleanup;
}

function reportRetainedDesktopCleanup(
  sessionId: string,
  trigger: 'pong_timeout' | 'revoked' | 'revocation_check_failed' | 'lease_renewal',
): void {
  console.error('[DesktopWs] cleanup retained for durable recovery', {
    sessionId: sessionId.slice(0, 12),
    trigger,
  });
}

async function validateDesktopUpgradeContext(
  context: RemoteWsUpgradeContext,
): Promise<Awaited<ReturnType<typeof validateDesktopAccess>>> {
  const result = context.authorizationPhase === 'complete'
    ? { ok: true as const, context: context.authorization }
    : await authorizeConsumedRemoteWsTicket(context.ticket);
  if (!result.ok) return { valid: false, error: result.reason };
  const authorization = result.context;
  return {
    valid: true,
    userId: authorization.userId,
    session: {
      id: authorization.sessionId,
      type: 'desktop',
      userId: authorization.userId,
      deviceId: authorization.deviceId,
      orgId: authorization.orgId,
      status: 'pending',
    } as typeof remoteSessions.$inferSelect,
    device: {
      id: authorization.deviceId,
      orgId: authorization.orgId,
      siteId: authorization.siteId,
      agentId: authorization.agentId,
      hostname: authorization.deviceHostname ?? '',
      osType: authorization.deviceOsType ?? '',
      status: 'online',
    } as typeof devices.$inferSelect,
  };
}

/**
 * Create WebSocket handlers for desktop session
 */
function createDesktopWsHandlers(
  sessionId: string,
  ticket: string | undefined,
  caller: { ip: string; userAgent: string },
  sharedLeases: RemoteWsSharedLeaseManager,
  upgradeContext?: RemoteWsUpgradeContext,
) {
  let validationResult: Awaited<ReturnType<typeof validateDesktopAccess>> | null = null;
  let connectionIdentity: RemoteConnectionIdentity | null = null;
  const validationPromise = (
    upgradeContext
      ? validateDesktopUpgradeContext(upgradeContext)
      : validateDesktopAccess(sessionId, ticket, caller)
  ).then(result => {
    validationResult = result;
  });
  const releaseOpeningReservation = async () => {
    if (!upgradeContext) return;
    removeExactLocalRemoteConnection(
      activeDesktopSessions,
      sessionId,
      getRemoteWsUpgradeConnection(upgradeContext),
    );
    upgradeContext.sharedClaim.safeForwardingUntilMonotonicMs = 0;
    await sharedLeases.release(upgradeContext.sharedClaim);
  };

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      // E3: track validation/setup progress so the catch block can clean up
      // any partial state (session entry, frame callback, ping interval, DB row).
      let validated = false;
      let pingInterval: ReturnType<typeof setInterval> | null = null;
      let sessionStored = false;
      let frameCallbackRegistered = false;

      try {
        console.log(`Desktop WebSocket onOpen for session ${sessionId}`);
        await validationPromise;

        if (!validationResult || !validationResult.valid) {
          await releaseOpeningReservation();
          console.warn(`Desktop WebSocket rejected for session ${sessionId}: ${validationResult?.error}`);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AUTH_FAILED',
            message: validationResult?.error || 'Authentication failed'
          }));
          ws.close(4001, 'Authentication failed');
          return;
        }

        const { session, device, userId } = validationResult;
        if (!session || !device || !userId) {
          await releaseOpeningReservation();
          ws.close(4001, 'Invalid session data');
          return;
        }

        if (!isAgentConnected(device.agentId)) {
          await releaseOpeningReservation();
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_OFFLINE',
            message: 'Agent is not connected via WebSocket'
          }));
          ws.close(4002, 'Agent offline');
          return;
        }

        // E1: Redis-backed rate limit user WS connections (fail-closed)
        if (!upgradeContext && await isUserDesktopWsRateLimited(userId)) {
          console.warn(`Desktop WebSocket rate limited for user ${userId}`);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many connection attempts'
          }));
          ws.close(4029, 'Rate limited');
          return;
        }

        const acquired = upgradeContext
          ? { ok: true as const, claim: upgradeContext.sharedClaim }
          : await sharedLeases.acquire('desktop', sessionId);
        if (!acquired.ok) {
          ws.close(
            acquired.reason === 'already_owned'
              || acquired.reason === 'desktop_finalizing'
              || acquired.reason === 'desktop_orphan_recovery'
              ? 4009
              : 1011,
            'Desktop session unavailable',
          );
          return;
        }

        // All validation and shared acquisition passed — safe to touch DB
        // state for this exact connection generation.
        validated = true;

        const now = Date.now();
        const existingReservation = upgradeContext
          ? activeDesktopSessions.get(sessionId)
          : undefined;
        if (existingReservation && upgradeContext) {
          Object.assign(existingReservation, {
            agentId: device.agentId,
            userId,
            deviceId: device.id,
            orgId: device.orgId,
            startedAt: new Date(),
            lastPongAt: now,
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
              activeDesktopSessions,
              sessionId,
              acquired.claim,
              (claim): DesktopSession => ({
                ...claim,
                state: 'opening',
                userWs: null,
                sharedOwner: claim,
                sharedLeases,
                agentId: device.agentId,
                userId,
                deviceId: device.id,
                orgId: device.orgId,
                startedAt: new Date(),
                lastPongAt: now,
                inputTokens: DESKTOP_INPUT_BUCKET_CAPACITY,
                inputLastRefillMs: now,
                inputOverageLogged: false,
                inputEvents: 0,
                frameBytes: 0,
                detachComplete: false,
                stopConfirmed: false,
                intentAcknowledged: false,
              }),
            );
        if (!installed.ok) {
          await sharedLeases.release(acquired.claim);
          ws.close(4009, 'Desktop session already owned');
          return;
        }
        connectionIdentity = {
          connectionId: acquired.claim.connectionId,
          generation: acquired.claim.generation,
          instanceId: acquired.claim.instanceId,
          leaseToken: acquired.claim.leaseToken,
        };
        if (!bindRemoteConnection(
          activeDesktopSessions,
          sessionId,
          connectionIdentity,
          ws,
        )) {
          removeExactLocalRemoteConnection(activeDesktopSessions, sessionId, connectionIdentity);
          await sharedLeases.release(acquired.claim);
          ws.close(1011, 'Desktop session binding failed');
          return;
        }
        sessionStored = true;
        const boundSession = activeDesktopSessions.get(sessionId);
        if (!boundSession) {
          throw new Error('desktop connection missing after bind');
        }
        const boundIdentity = connectionIdentity;
        boundSession.leaseRenewalInterval = setInterval(() => {
          void renewExactRemoteConnectionLease(
            activeDesktopSessions,
            sessionId,
            boundIdentity,
            ws,
            () => sharedLeases.renew(boundSession.sharedOwner),
          ).then((renewed) => {
            if (!renewed) {
              void closeDesktopSessionLifecycle(sessionId, {
                expectedWs: ws,
                connection: boundIdentity,
                reason: 'socket_error',
                terminalStatus: 'failed',
                notifyAgent: true,
              }).catch(() => {
                reportRetainedDesktopCleanup(sessionId, 'lease_renewal');
              });
            }
          });
        }, REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS);

        // Register frame callback — relay binary JPEG frames directly to viewer
        registerDesktopFrameCallback(sessionId, (data: Uint8Array) => {
          try {
            // Copy into a fresh ArrayBuffer to satisfy WSContext.send() type
            const buf = new ArrayBuffer(data.byteLength);
            new Uint8Array(buf).set(data);
            const sess = activeDesktopSessions.get(sessionId);
            if (
              sess
              && connectionIdentity
              && ownsSafeRemoteConnection(
                activeDesktopSessions,
                sessionId,
                connectionIdentity,
                ws,
              )
            ) {
              sess.frameBytes += data.byteLength;
              ws.send(buf);
            }
          } catch (error) {
            console.error(`Failed to send desktop frame to session ${sessionId}:`, error);
          }
        });
        frameCallbackRegistered = true;

        if (!ownsSafeRemoteConnection(
          activeDesktopSessions,
          sessionId,
          boundIdentity,
          ws,
        )) {
          await closeDesktopSessionLifecycle(sessionId, {
            expectedWs: ws,
            connection: boundIdentity,
            reason: 'setup_failed',
            terminalStatus: 'failed',
            notifyAgent: true,
          });
          return;
        }

        // Update only a still-open row. A prior owner may have made the row
        // terminal after validation but before this exact lease was bound.
        const [activated] = await withSystemDbAccessContext(() =>
          db.update(remoteSessions)
            .set({ status: 'active', startedAt: new Date() })
            .where(and(
              eq(remoteSessions.id, sessionId),
              inArray(remoteSessions.status, ['pending', 'connecting']),
            ))
            .returning({ id: remoteSessions.id })
        );
        if (
          !activated
          || !ownsSafeRemoteConnection(
            activeDesktopSessions,
            sessionId,
            boundIdentity,
            ws,
          )
        ) {
          await closeDesktopSessionLifecycle(sessionId, {
            expectedWs: ws,
            connection: boundIdentity,
            reason: 'setup_failed',
            terminalStatus: 'failed',
            notifyAgent: true,
          });
          return;
        }

        // Send desktop_stream_start command to agent
        const startCommand = {
          id: `desk-start-${sessionId}`,
          type: 'desktop_stream_start',
          payload: {
            sessionId,
            quality: 60,
            scaleFactor: 1.0,
            maxFps: 15
          }
        };

        if (!ownsSafeRemoteConnection(
          activeDesktopSessions,
          sessionId,
          boundIdentity,
          ws,
        )) {
          await closeDesktopSessionLifecycle(sessionId, {
            expectedWs: ws,
            connection: boundIdentity,
            reason: 'setup_failed',
            terminalStatus: 'failed',
            notifyAgent: true,
          });
          return;
        }
        const sent = sendCommandToAgent(device.agentId, startCommand);
        if (!sent) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_SEND_FAILED',
            message: 'Failed to send start command to agent'
          }));
          if (connectionIdentity) {
            await closeDesktopSessionLifecycle(sessionId, {
              expectedWs: ws,
              connection: connectionIdentity,
              reason: 'setup_failed',
              terminalStatus: 'failed',
              notifyAgent: true,
            });
          }
          ws.close(4003, 'Agent send failed');
          return;
        }

        if (!ownsSafeRemoteConnection(
          activeDesktopSessions,
          sessionId,
          boundIdentity,
          ws,
        )) {
          await closeDesktopSessionLifecycle(sessionId, {
            expectedWs: ws,
            connection: boundIdentity,
            reason: 'setup_failed',
            terminalStatus: 'failed',
            notifyAgent: true,
          });
          return;
        }

        // Send connected message to viewer
        ws.send(JSON.stringify({
          type: 'connected',
          sessionId,
          device: {
            hostname: device.hostname,
            osType: device.osType
          }
        }));

        // Start server-side ping/pong for stale connection detection
        pingInterval = setInterval(() => {
          const deskSess = activeDesktopSessions.get(sessionId);
          if (
            !deskSess
            || !connectionIdentity
            || !ownsSafeRemoteConnection(
              activeDesktopSessions,
              sessionId,
              connectionIdentity,
              ws,
            )
          ) {
            if (pingInterval) clearInterval(pingInterval);
            return;
          }
          const elapsed = Date.now() - deskSess.lastPongAt;
          if (elapsed > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
            console.warn(`Desktop session ${sessionId} pong timeout (${elapsed}ms), closing`);
            if (pingInterval) clearInterval(pingInterval);
            void closeDesktopSessionLifecycle(sessionId, {
              expectedWs: ws,
              connection: connectionIdentity,
              reason: 'pong_timeout',
              terminalStatus: 'failed',
              notifyAgent: true,
            }).catch(() => {
              reportRetainedDesktopCleanup(sessionId, 'pong_timeout');
            });
            return;
          }
          // Enforce mid-session revocation on the live socket. Nothing else
          // re-checks authorization once a Flow-A session is streaming, so a
          // revoke (operator suspended #3, policy disabled #1, session ended
          // elsewhere #2/#5) would otherwise keep frames + input flowing until
          // pong timeout — or indefinitely while the client answers pings.
          // A revoked socket closes within at most one ping interval
          // (`PING_INTERVAL_MS`, ~30s). Finding #4.
          // (isViewerSessionRevoked fails closed, matching the connect gate.)
          void isViewerSessionRevoked(sessionId)
            .then((revoked) => {
              if (
                revoked
                && connectionIdentity
                && ownsSafeRemoteConnection(
                  activeDesktopSessions,
                  sessionId,
                  connectionIdentity,
                  ws,
                )
              ) {
                console.warn(`[DesktopWs] Session ${sessionId} revoked mid-session, closing socket`);
                if (pingInterval) clearInterval(pingInterval);
                void closeDesktopSessionLifecycle(sessionId, {
                  expectedWs: ws,
                  connection: connectionIdentity,
                  reason: 'revoked',
                  terminalStatus: 'failed',
                  notifyAgent: true,
                }).catch(() => {
                  reportRetainedDesktopCleanup(sessionId, 'revoked');
                });
              }
            })
            .catch((revErr) => {
              // I3: a thrown rejection (not just Redis-down, which already
              // resolves `true`) must also fail CLOSED. Tear the socket down
              // this tick rather than leaving it streaming on an unhandled
              // rejection. Finding #4 / I3.
              console.error(
                `[DesktopWs] Revocation check failed for session ${sessionId}, closing socket (fail-closed):`,
                revErr
              );
              if (pingInterval) clearInterval(pingInterval);
              if (
                connectionIdentity
                && ownsSafeRemoteConnection(
                  activeDesktopSessions,
                  sessionId,
                  connectionIdentity,
                  ws,
                )
              ) {
                void closeDesktopSessionLifecycle(sessionId, {
                  expectedWs: ws,
                  connection: connectionIdentity,
                  reason: 'revoked',
                  terminalStatus: 'failed',
                  notifyAgent: true,
                }).then(() => {
                  try {
                    ws.close(4003, 'Session revocation check failed');
                  } catch {
                    // The lifecycle already closed the exact socket.
                  }
                }).catch(() => {
                  reportRetainedDesktopCleanup(
                    sessionId,
                    'revocation_check_failed',
                  );
                });
              }
            });
          try {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          } catch (err) {
            console.warn(`[DesktopWs] Ping send failed for session ${sessionId}, cleaning up`, err);
            if (pingInterval) clearInterval(pingInterval);
          }
        }, PING_INTERVAL_MS);

        const currentSession = activeDesktopSessions.get(sessionId);
        if (currentSession && connectionIdentity) {
          currentSession.pingInterval = pingInterval;
        }

        console.log(`Desktop session ${sessionId} connected for device ${device.hostname}`);
      } catch (error) {
        // E3: mirror terminalWs.ts onOpen cleanup on early throw.
        console.error(`[DesktopWs] onOpen failed for session ${sessionId}:`, error);

        if (pingInterval) {
          clearInterval(pingInterval);
        }
        if (sessionStored && connectionIdentity) {
          await closeDesktopSessionLifecycle(sessionId, {
            expectedWs: ws,
            connection: connectionIdentity,
            reason: 'setup_failed',
            terminalStatus: 'failed',
            notifyAgent: true,
          }).catch((cleanupError) => {
            console.error(`[DesktopWs] setup cleanup retained for retry ${sessionId}:`, cleanupError);
          });
        } else if (frameCallbackRegistered) {
          unregisterDesktopFrameCallback(sessionId);
        } else {
          await releaseOpeningReservation();
        }

        try {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INTERNAL_ERROR',
            message: 'Desktop session setup failed'
          }));
          ws.close(1011, 'internal_error');
        } catch (closeError) {
          console.error(`[DesktopWs] Failed to close WS after onOpen error for session ${sessionId}:`, closeError);
        }
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const desktopSession = activeDesktopSessions.get(sessionId);
      if (!desktopSession) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Desktop session not found'
        }));
        return;
      }
      if (
        !connectionIdentity
        || !ownsSafeRemoteConnection(
          activeDesktopSessions,
          sessionId,
          connectionIdentity,
          ws,
        )
      ) {
        return;
      }

      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const raw = JSON.parse(data);

        // Handle pong responses for server-initiated ping (not in discriminatedUnion)
        if (raw?.type === 'pong') {
          desktopSession.lastPongAt = Date.now();
          return;
        }

        const parsed = desktopMessageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn(`Invalid desktop message from session ${sessionId}:`, parsed.error.issues);
          return;
        }
        const message = parsed.data;

        switch (message.type) {
          case 'input': {
            // E2: token-bucket rate limit (60 events/sec). On breach, drop
            // the excess but keep the session open — a stuck mouse should
            // not kill an active remote-control session. Log the first overage.
            const nowMs = Date.now();
            const elapsedMs = Math.max(0, nowMs - desktopSession.inputLastRefillMs);
            const refill = (elapsedMs / 1000) * DESKTOP_INPUT_TOKENS_PER_SEC;
            desktopSession.inputTokens = Math.min(
              DESKTOP_INPUT_BUCKET_CAPACITY,
              desktopSession.inputTokens + refill
            );
            desktopSession.inputLastRefillMs = nowMs;

            if (desktopSession.inputTokens < 1) {
              if (!desktopSession.inputOverageLogged) {
                console.warn(`Desktop session ${sessionId} input rate-limited (token bucket empty)`);
                desktopSession.inputOverageLogged = true;
              }
              break; // drop event, keep session open
            }
            desktopSession.inputTokens -= 1;
            desktopSession.inputEvents += 1;

            const sent = sendCommandToAgent(desktopSession.agentId, {
              id: `desk-input-${Date.now()}`,
              type: 'desktop_input',
              payload: {
                sessionId,
                event: message.event
              }
            });
            if (!sent) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'AGENT_DISCONNECTED',
                message: 'Agent is no longer connected'
              }));
            }
            break;
          }

          case 'config': {
            const sent = sendCommandToAgent(desktopSession.agentId, {
              id: `desk-config-${Date.now()}`,
              type: 'desktop_config',
              payload: {
                sessionId,
                ...(message.quality !== undefined && { quality: message.quality }),
                ...(message.scaleFactor !== undefined && { scaleFactor: message.scaleFactor }),
                ...(message.maxFps !== undefined && { maxFps: message.maxFps })
              }
            });
            if (!sent) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'AGENT_DISCONNECTED',
                message: 'Agent is no longer connected'
              }));
            }
            break;
          }

          case 'ping':
            // Client-initiated ping — respond with pong and update timestamp
            desktopSession.lastPongAt = Date.now();
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }
      } catch (error) {
        console.error(`Error processing desktop message for session ${sessionId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

    onClose: async (_event: unknown, ws: WSContext) => {
      if (!connectionIdentity) return;
      await closeDesktopSessionLifecycle(sessionId, {
        expectedWs: ws,
        connection: connectionIdentity,
        reason: 'client_close',
        terminalStatus: 'disconnected',
        notifyAgent: true,
      });
    },

    onError: async (event: unknown, ws: WSContext) => {
      console.error(`Desktop WebSocket error for session ${sessionId}:`, event);
      if (!connectionIdentity) return;
      await closeDesktopSessionLifecycle(sessionId, {
        expectedWs: ws,
        connection: connectionIdentity,
        reason: 'socket_error',
        terminalStatus: 'failed',
        notifyAgent: true,
      });
    }
  };
}

/**
 * Create desktop WebSocket routes
 */
export function createDesktopWsRoutes(
  upgradeWebSocket: Function,
  options: { sharedLeases?: RemoteWsSharedLeaseManager } = {},
): Hono {
  assertRemoteWsUpgradeRuntimeReady();
  const app = new Hono();

  // Health check for debugging route registration
  app.get('/health', (c) => c.json({ ok: true, route: 'desktop-ws' }));

  // Exchange one-time deep-link connect code for an access token.
  // This keeps long-lived bearer credentials out of deep-link URLs.
  //
  // The connect code is strictly single-use: `consumeDesktopConnectCode` is
  // atomic (Redis GETDEL / in-memory consume), so a second exchange attempt
  // returns 401 even within the original code TTL. Clients must guard against
  // React strict-mode double-fire on their side (e.g. a useRef one-shot guard).
  app.post(
    '/connect/exchange',
    zValidator('json', desktopConnectExchangeSchema),
    async (c) => {
      const { sessionId, code } = c.req.valid('json');

      const codeRecord = await consumeDesktopConnectCode(code);

      if (!codeRecord || codeRecord.sessionId !== sessionId) {
        return c.json({ error: 'Invalid or expired connect code' }, 401);
      }

      if (!codeRecord.email) {
        return c.json({ error: 'Invalid or expired connect code' }, 401); // Reject pre-deployment codes missing email field
      }

      // Connect-code exchange bypasses JWT middleware so no RLS context is set.
      // Use system scope — the one-time code already verified ownership.
      const dbResult = await withSystemDbAccessContext(async () => {
        const [session] = await db
          .select({
            id: remoteSessions.id,
            userId: remoteSessions.userId,
            type: remoteSessions.type,
            status: remoteSessions.status,
            deviceId: remoteSessions.deviceId,
          })
          .from(remoteSessions)
          .where(eq(remoteSessions.id, sessionId))
          .limit(1);

        let hostname: string | undefined;
        let osType: string | undefined;
        if (session?.deviceId) {
          try {
            const [device] = await db
              .select({ hostname: devices.hostname, osType: devices.osType })
              .from(devices)
              .where(eq(devices.id, session.deviceId))
              .limit(1);
            hostname = device?.hostname ?? undefined;
            osType = device?.osType ?? undefined;
          } catch (err) {
            console.error('Failed to look up device hostname for viewer title:', err);
          }
        }

        return { session, hostname, osType };
      });

      const { session, hostname, osType } = dbResult;

      if (!session || session.type !== 'desktop' || session.userId !== codeRecord.userId) {
        return c.json({ error: 'Invalid or expired connect code' }, 401);
      }

      if (!['pending', 'connecting', 'active'].includes(session.status)) {
        return c.json({ error: 'Session is not available for connection' }, 400);
      }

      const accessToken = await createViewerAccessToken({
        sub: codeRecord.userId,
        email: codeRecord.email,
        sessionId: session.id,
        mfaSatisfied: true,
      });
      const result = {
        accessToken,
        expiresInSeconds: getViewerAccessTokenExpirySeconds(),
        hostname: hostname ?? null,
        osType: osType ?? null,
      };

      return c.json(result);
    }
  );

  app.get(
    '/:id/viewer/ice-servers',
    zValidator('param', desktopSessionIdParamSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      if (!['pending', 'connecting', 'active', 'disconnected'].includes(access.session.status)) {
        return c.json({
          error: 'Cannot fetch ICE servers for session in current state',
          status: access.session.status
        }, 400);
      }

      return c.json({
        iceServers: getIceServers({
          sessionId,
          userId: access.session.userId,
          deviceId: access.session.deviceId,
        })
      });
    }
  );

  app.post(
    '/:id/viewer/ws-ticket',
    zValidator('param', desktopSessionIdParamSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const authorizationHeader = c.req.header('Authorization');
      if (!authorizationHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Missing viewer token' }, 401);
      }
      const viewerToken = await verifyViewerAccessToken(authorizationHeader.slice(7));
      if (!viewerToken) {
        return c.json({ error: 'Invalid or expired viewer token' }, 401);
      }
      const mode = process.env.REMOTE_WS_AUTH_MODE === 'pre_upgrade'
        ? 'pre_upgrade'
        : 'post_upgrade';
      if (viewerToken.mfaSatisfied !== true && mode === 'pre_upgrade') {
        return c.json({ error: 'mfa_unassured' }, 403);
      }

      const access = await validateViewerSessionAccess(
        authorizationHeader,
        sessionId,
        viewerToken,
      );
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      if (!['pending', 'connecting', 'active'].includes(access.session.status)) {
        return c.json({
          error: 'Cannot mint WebSocket ticket for session in current state',
          status: access.session.status
        }, 400);
      }

      try {
        const ticketInput = {
          sessionId: access.session.id,
          sessionType: 'desktop' as const,
          userId: access.user.id,
          ip: getTrustedClientIp(c),
          userAgent: c.req.header('user-agent') ?? '',
        };
        const ticket = access.viewerToken.mfaSatisfied === true
          ? await createWsTicket({ ...ticketInput, mfaSatisfied: true })
          : await createLegacyViewerCompatibilityWsTicket({ ...ticketInput, mode });
        return c.json(ticket);
      } catch (error) {
        console.error('[desktop-ws] Failed to create viewer WebSocket ticket:', error);
        return c.json({ error: 'Unable to create WebSocket ticket. Please try again later.' }, 503);
      }
    }
  );

  app.post(
    '/:id/viewer/offer',
    zValidator('param', desktopSessionIdParamSchema),
    zValidator('json', webrtcOfferSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const data = c.req.valid('json');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      // validateViewerSessionAccess already rejects ended sessions (#5); only
      // genuine in-flight reconnect states remain here. Never resurrect a
      // disconnected/failed row.
      if (!['pending', 'connecting', 'active'].includes(access.session.status)) {
        return c.json({
          error: 'Cannot submit offer for session in current state',
          status: access.session.status
        }, 400);
      }

      const [updated] = await withSystemDbAccessContext(() =>
        db.update(remoteSessions)
          .set({
            webrtcOffer: data.offer,
            webrtcAnswer: null,
            status: 'connecting',
            ...(access.session.status === 'active' ? { endedAt: null } : {}),
          })
          .where(eq(remoteSessions.id, sessionId))
          .returning()
      );

      if (!updated) {
        return c.json({ error: 'Failed to update session' }, 500);
      }

      await logSessionAudit(
        'session_offer_submitted',
        access.user.id,
        access.device.orgId,
        { sessionId, type: access.session.type, via: 'viewer_token' },
        getTrustedClientIp(c, 'unknown')
      );

      if (!access.device.agentId) {
        console.error(`[desktop-ws] Device ${access.device.id} has no agentId, cannot send start_desktop for session ${sessionId}`);
        return c.json({ error: 'Device has no agent connection identifier' }, 502);
      }

      // Ship the agent-enforced desktop policy (clipboard direction gates +
      // idle / max-duration limits) so the agent enforces it locally — the
      // viewer is untrusted. Findings #2 and #7.
      const desktopPolicy = await resolveDesktopSessionPolicy(access.device.id);
      // Consent/notification prompt + on-screen session banner config, same as
      // the REST offer route — without it the agent shows no "technician
      // connected" notice or indicator for viewer-token sessions.
      const prompt = await buildRemoteSessionPromptPayload(
        access.device,
        access.session.userId
      );
      const agentReachable = sendCommandToAgent(access.device.agentId, {
        id: `desk-start-${sessionId}`,
        type: 'start_desktop',
        payload: {
          sessionId,
          offer: data.offer,
          iceServers: getIceServers({
            sessionId,
            userId: access.session.userId,
            deviceId: access.session.deviceId,
          }),
          clipboard: desktopPolicy.clipboard,
          idleTimeoutMinutes: desktopPolicy.idleTimeoutMinutes,
          maxSessionDurationHours: desktopPolicy.maxSessionDurationHours,
          ...(data.displayIndex != null ? { displayIndex: data.displayIndex } : {}),
          ...(data.targetSessionId != null ? { targetSessionId: data.targetSessionId } : {}),
          ...(prompt ? { prompt } : {})
        }
      });

      if (!agentReachable) {
        console.warn(`[desktop-ws] Agent ${access.device.agentId} not connected, cannot send start_desktop for session ${sessionId}`);
        return c.json({ error: 'Agent is not currently connected. Please verify the device is online and try again.' }, 502);
      }

      return c.json({
        id: updated.id,
        status: updated.status,
        webrtcOffer: updated.webrtcOffer,
      });
    }
  );

  app.get(
    '/:id/viewer/session',
    zValidator('param', desktopSessionIdParamSchema),
    async (c) => {
      const { id: sessionId } = c.req.valid('param');
      const access = await validateViewerSessionAccess(c.req.header('Authorization'), sessionId);
      if (!access.valid) {
        return c.json({ error: access.error }, access.status);
      }

      return c.json({
        id: access.session.id,
        status: access.session.status,
        webrtcAnswer: access.session.webrtcAnswer,
        errorMessage: access.session.errorMessage,
        startedAt: access.session.startedAt,
        endedAt: access.session.endedAt,
      });
    }
  );

  // WebSocket route for desktop sessions
  // GET /api/v1/desktop-ws/:id/ws?ticket=xxx
  app.get(
    '/:id/ws',
    async (c, next) => {
      const sharedLeases = options.sharedLeases ?? getRemoteWsSharedLeaseManager();
      if (!sharedLeases) {
        return c.json({ error: 'Remote ownership unavailable' }, 503);
      }
      return requireRemoteWsUpgrade({
        expectedType: 'desktop',
        sharedLeases,
        installLocal: (sessionId, claim) => {
          const now = Date.now();
          return installLocalRemoteConnection(
            activeDesktopSessions,
            sessionId,
            claim,
            (shared): DesktopSession => ({
              ...shared,
              state: 'opening',
              userWs: null,
              sharedOwner: shared,
              sharedLeases,
              agentId: '',
              userId: '',
              deviceId: '',
              orgId: '',
              startedAt: new Date(),
              lastPongAt: now,
              inputTokens: DESKTOP_INPUT_BUCKET_CAPACITY,
              inputLastRefillMs: now,
              inputOverageLogged: false,
              inputEvents: 0,
              frameBytes: 0,
              detachComplete: false,
              stopConfirmed: false,
              intentAcknowledged: false,
            }),
          );
        },
        removeLocal: (sessionId, claim) =>
          removeExactLocalRemoteConnection(activeDesktopSessions, sessionId, claim),
      })(c, next);
    },
    upgradeWebSocket((c: {
      get?: (key: string) => unknown;
      req: {
        param: (key: string) => string;
        query: (key: string) => string | undefined;
        header: (key: string) => string | undefined;
      };
    }) => {
      const sessionId = c.req.param('id');
      const ticket = c.req.query('ticket');
      // Task 16: bind ticket consumption to issuer IP + UA.
      const caller = {
        ip: getTrustedClientIp(c as Parameters<typeof getTrustedClientIp>[0]),
        userAgent: c.req.header('user-agent') ?? '',
      };
      const sharedLeases = options.sharedLeases ?? getRemoteWsSharedLeaseManager();
      if (!sharedLeases) {
        return {
          onOpen: (_event: unknown, ws: WSContext) => {
            ws.close(1011, 'Remote ownership unavailable');
          },
          onMessage: () => undefined,
          onClose: () => undefined,
          onError: () => undefined,
        };
      }
      const context = c.get?.('remoteWs') as RemoteWsUpgradeContext | undefined;
      return createDesktopWsHandlers(sessionId, ticket, caller, sharedLeases, context);
    })
  );

  return app;
}

/**
 * Check if an agent owns a given desktop session
 */
export function isDesktopSessionOwnedByAgent(sessionId: string, agentId: string): boolean {
  const session = activeDesktopSessions.get(sessionId);
  return session !== undefined && session.agentId === agentId;
}

/**
 * Get count of active desktop sessions
 */
export function getActiveDesktopSessionCount(): number {
  return activeDesktopSessions.size;
}

export function __resetDesktopWsForTest(): void {
  for (const session of activeDesktopSessions.values()) {
    if (session.pingInterval) clearInterval(session.pingInterval);
    if (session.leaseRenewalInterval) clearInterval(session.leaseRenewalInterval);
    if (session.cleanupRetryTimeout) clearTimeout(session.cleanupRetryTimeout);
  }
  activeDesktopSessions.clear();
  desktopFrameCallbacks.clear();
}

export function __createDesktopSharedLeasesForTest(): RemoteWsSharedLeaseManager {
  let generation = 0;
  return {
    acquire: async (kind, sessionId) => {
      generation += 1;
      const claim: RemoteWsSharedLeaseClaim = {
        kind,
        sessionId,
        connectionId: '33333333-3333-4333-8333-333333333333',
        generation,
        instanceId: '44444444-4444-4444-8444-444444444444',
        leaseToken: '55555555-5555-4555-8555-555555555555',
        ownerValue: `test-owner-${generation}`,
        safeForwardingUntilMonotonicMs: Number.MAX_SAFE_INTEGER,
      };
      return { ok: true, claim };
    },
    renew: async (claim) => claim,
    beginClose: async () => ({ ok: true, ownership: 'still_owner' }),
    release: async () => true,
    writeDesktopFinalizationIntent: async () => 'written',
    claimDesktopOrphan: async () => 'claimed',
    releaseDesktopFinalizationIntent: async () => true,
    observeDesktopFinalization: async () => ({
      ownerPresent: false,
      finalizationId: null,
      canonicalPayload: null,
      consistent: true,
    }),
    topology: {} as RemoteWsSharedLeaseManager['topology'],
  };
}
