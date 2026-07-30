import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { remoteSessions, devices, users } from '../db/schema';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { logSessionAudit } from './remote/helpers';
import { getTrustedClientIp } from '../services/clientIp';
import { createAuditLogAsync } from '../services/auditService';
import { isViewerSessionRevoked } from '../services/viewerTokenRevocation';
import { authorizeConsumedRemoteWsTicket } from '../services/remoteWsAuthorization';
import {
  assertRemoteWsUpgradeRuntimeReady,
  getRemoteWsUpgradeConnection,
  requireRemoteWsUpgrade,
  type RemoteWsUpgradeContext,
} from '../services/remoteWsUpgrade';
import {
  getRemoteWsSharedLeaseManager,
  REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS,
  type RemoteWsSharedLeaseClaim,
  type RemoteWsSharedLeaseManager,
} from '../services/remoteWsSharedLease';
import {
  bindRemoteConnection,
  installLocalRemoteConnection,
  ownsSafeRemoteConnection,
  removeExactLocalRemoteConnection,
  renewExactRemoteConnectionLease,
  type RemoteConnectionIdentity,
  type RemoteConnectionLease,
} from '../services/remoteWsOwnership';

// Zod validation for terminal user messages
const terminalMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.string().max(16384) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(500) }),
  z.object({ type: z.literal('ping') }),
]);

// Store active terminal sessions.
//
// The map is keyed by session ID but ownership is NEVER decided by that key
// alone: every entry carries the exact shared-lease identity (connection id,
// generation, instance id, lease token) that installed it, and every event,
// timer, and captured callback re-proves that exact identity before touching
// state. A foreign socket, a socket from a replaced generation, or a replica
// that lost its lease is inert — see `ownsSafeRemoteConnection`.
interface TerminalSession extends RemoteConnectionLease {
  agentId: string;
  userId: string;
  deviceId: string;
  orgId: string;
  startedAt: Date;
  pingInterval?: ReturnType<typeof setInterval>;
  leaseRenewalInterval?: ReturnType<typeof setInterval>;
  lastPongAt: number;
  // Per-session input rate limiting (sliding window)
  // E2: 200 messages/min OR 1MB total bytes/min, whichever first
  msgTimestamps: number[];
  msgByteTimestamps: Array<{ ts: number; bytes: number }>;
  // E2: audit summary counters
  bytesIn: number;
  bytesOut: number;
  sharedOwner: RemoteWsSharedLeaseClaim;
  sharedLeases: RemoteWsSharedLeaseManager;
  // Exact command id of the `terminal_start` this generation dispatched. A
  // late agent failure result is only honoured against a matching id, so a
  // superseded generation's failure can never kill the current owner.
  startCommandId?: string;
}

// E2: per-session input limits
const TERMINAL_MSG_WINDOW_MS = 60_000;
const TERMINAL_MSG_LIMIT = 200; // messages per minute
const TERMINAL_BYTES_LIMIT = 1_048_576; // 1MB per minute

const activeTerminalSessions = new Map<string, TerminalSession>();

// Store pending terminal output to relay back to user
// Map<sessionId, callback>
type TerminalOutputCallback = (data: string) => void;
const terminalOutputCallbacks = new Map<string, TerminalOutputCallback>();

function terminalStartCommandId(sessionId: string, generation: number): string {
  // The generation comes from a Redis INCR that is monotonic per session, so
  // this id is unique per connection generation. The agent treats the id as
  // opaque and echoes it back on the result, which is what lets a late
  // `terminal_start` failure be matched to the exact generation that sent it.
  return `term-start-${sessionId}-${generation}`;
}

// Monotonic suffix for per-message terminal command ids. `Date.now()` alone is
// NOT unique: two keystrokes relayed in the same millisecond used to get the
// SAME command id, and the agent's command dedupe (markCommandSeen) silently
// dropped the second one — lost input — while its duplicate WS result produced
// the `ws_result_terminal_cas` 0-row warnings (#2870). The counter makes every
// id unique within this process; the Date.now() prefix keeps ids unique across
// process restarts and readable in logs.
let terminalCommandSeq = 0;
function nextTerminalCommandId(kind: 'data' | 'resize'): string {
  terminalCommandSeq = (terminalCommandSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `term-${kind}-${Date.now()}-${terminalCommandSeq}`;
}

// Server-side ping/pong constants for stale connection detection
const PING_INTERVAL_MS = 30_000; // Send ping every 30 seconds
const PONG_TIMEOUT_MS = 10_000; // Close if no pong within 10 seconds

// E1: Redis-backed sliding window rate limiter for user WS upgrades.
// Decision: fail closed on Redis outage (matches `rateLimiter` helper default).
// Rationale: user-initiated WS — users can retry; an open door during a Redis
// blip is a bigger risk than a temporary 4029 for a real user.
const USER_WS_RATE_LIMIT = 10; // max 10 connections per user per minute
const USER_WS_RATE_WINDOW_SECONDS = 60;

async function isUserTerminalWsRateLimited(userId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await rateLimiter(
    redis,
    `terminalws:conn:${userId}`,
    USER_WS_RATE_LIMIT,
    USER_WS_RATE_WINDOW_SECONDS
  );
  return !result.allowed;
}

/**
 * Validate one-time WS ticket and session access
 */
async function validateTerminalAccess(
  sessionId: string,
  ticket: string | undefined,
  caller: { ip: string; userAgent: string }
): Promise<{ valid: boolean; error?: string; session?: typeof remoteSessions.$inferSelect; device?: typeof devices.$inferSelect; userId?: string }> {
  if (!ticket) {
    return { valid: false, error: 'Missing connection ticket' };
  }

  const consumed = await consumeWsTicket(ticket, caller);
  if (!consumed.ok) {
    // Audit-log the rejection reason for ops visibility. We log a prefix
    // of the ticket (not the whole secret) for correlation with the issue
    // log.
    void createAuditLogAsync({
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000000',
      action: 'ws.ticket.rejected',
      resourceType: 'ws_ticket',
      resourceName: ticket.slice(0, 8),
      details: { reason: consumed.reason, sessionType: 'terminal', sessionId },
      ipAddress: caller.ip,
      userAgent: caller.userAgent,
      result: 'denied',
    });
    return { valid: false, error: 'Invalid or expired connection ticket' };
  }

  if (consumed.sessionId !== sessionId || consumed.sessionType !== 'terminal') {
    return { valid: false, error: 'Connection ticket does not match terminal session' };
  }
  const ticketRecord = consumed;

  // Ticket consumption is the entire auth boundary for terminal WS — the
  // WS routes mount before auth middleware. Run lookups in system DB
  // context so RLS doesn't fail-close the query. Subsequent checks
  // (session.userId === user.id) enforce tenant scoping in app code.
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

    // Get session with device info
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

    // Check session is for terminal
    if (session.type !== 'terminal') {
      return { valid: false, error: 'Session is not a terminal session' };
    }

    // Check session belongs to this user
    if (session.userId !== user.id) {
      return { valid: false, error: 'Session does not belong to this user' };
    }

    // Check session status
    if (!['pending', 'connecting', 'active'].includes(session.status)) {
      return { valid: false, error: `Session is ${session.status}` };
    }

    // Check device is online
    if (device.status !== 'online') {
      return { valid: false, error: 'Device is not online' };
    }

    // Remote access policy enforcement (defense-in-depth)
    const policyCheck = await checkRemoteAccess(device.id, 'remoteTools');
    if (!policyCheck.allowed) {
      return { valid: false, error: policyCheck.reason ?? 'Remote tools disabled by policy' };
    }

    return { valid: true, session, device, userId: user.id };
  });
}

/**
 * Handle terminal output from agent
 * Called by agentWs when it receives terminal data
 */
export function handleTerminalOutput(sessionId: string, data: string): void {
  const callback = terminalOutputCallbacks.get(sessionId);
  if (callback) {
    callback(data);
  }
}

/**
 * Register a callback for terminal output
 */
export function registerTerminalOutputCallback(sessionId: string, callback: TerminalOutputCallback): void {
  terminalOutputCallbacks.set(sessionId, callback);
}

/**
 * Unregister terminal output callback
 */
export function unregisterTerminalOutputCallback(sessionId: string): void {
  terminalOutputCallbacks.delete(sessionId);
}

/**
 * Get active terminal session
 */
export function getActiveTerminalSession(sessionId: string): TerminalSession | undefined {
  return activeTerminalSessions.get(sessionId);
}

function identityOf(session: TerminalSession): RemoteConnectionIdentity {
  return {
    connectionId: session.connectionId,
    generation: session.generation,
    instanceId: session.instanceId,
    leaseToken: session.leaseToken,
  };
}

function isExactTerminalConnection(
  session: TerminalSession,
  identity: RemoteConnectionIdentity,
): boolean {
  return (
    session.connectionId === identity.connectionId
    && session.generation === identity.generation
    && session.instanceId === identity.instanceId
    && session.leaseToken === identity.leaseToken
  );
}

interface CloseExactTerminalOptions {
  /** The socket this close is claimed on behalf of; `null` for an unbound (opening) entry. */
  expectedWs: WSContext | null;
  /** `false` when the socket is already gone (client-initiated close/error). */
  closeSocket: boolean;
  closeCode: number;
  closeReason: string;
  terminalStatus: 'disconnected' | 'failed';
  /** Write the E2 session-summary audit row (normal disconnects only). */
  writeSummary: boolean;
}

/**
 * Close exactly one terminal connection generation.
 *
 * Ownership is proved twice: locally (the installed entry must carry this
 * exact identity and socket) and durably (`beginClose` compares the Redis
 * owner value). Only a `still_owner` proof may stop the agent PTY or mutate
 * the session row — an `owner_mismatch` detaches this replica's stale local
 * state and nothing else, because some other generation legitimately owns the
 * session now.
 *
 * Forwarding is expired BEFORE any await so a concurrent frame, timer, or
 * agent callback cannot slip through the teardown window. The map entry is
 * deleted and the Redis lease compare-released only after the final matching
 * ownership check, so a delete can never strand a live shared owner.
 *
 * Idempotent: a second call while the first is in flight returns the same
 * promise rather than issuing a second `terminal_stop` or DB write.
 */
async function closeExactTerminalConnection(
  sessionId: string,
  identity: RemoteConnectionIdentity,
  options: CloseExactTerminalOptions,
): Promise<boolean> {
  const session = activeTerminalSessions.get(sessionId);
  if (!session || !isExactTerminalConnection(session, identity)) return false;
  if (session.userWs !== options.expectedWs) return false;
  if (session.cleanupPromise) return session.cleanupPromise.then(() => true);

  // Write-ahead: make this generation inert before the first await.
  session.state = 'closing';
  session.safeForwardingUntilMonotonicMs = 0;
  if (session.pingInterval) clearInterval(session.pingInterval);
  if (session.leaseRenewalInterval) clearInterval(session.leaseRenewalInterval);
  session.pingInterval = undefined;
  session.leaseRenewalInterval = undefined;

  const cleanup = (async () => {
    const proof = await session.sharedLeases
      .beginClose(session.sharedOwner)
      .catch(() => ({ ok: false as const, reason: 'unavailable' as const }));

    // `owner_mismatch` means another generation owns the session durably. Detach
    // this replica's stale state WITHOUT stopping the agent or writing the row —
    // doing either would tear down the legitimate current owner.
    const provenOwner = proof.ok;
    if (!provenOwner && proof.reason !== 'owner_mismatch') {
      // Redis unavailable: we cannot prove ownership either way. Fail closed on
      // the STREAM (stop the shell, close the socket) but do not compare-release
      // a lease we cannot compare.
      console.error(
        `[TerminalWs] Shared close proof unavailable for session ${sessionId}; failing closed without lease release`,
      );
    }
    const mayMutate = provenOwner || proof.reason === 'unavailable';

    if (mayMutate) {
      try {
        sendCommandToAgent(session.agentId, {
          id: `term-stop-${sessionId}`,
          type: 'terminal_stop',
          payload: { sessionId },
        });
      } catch (err) {
        console.error(`[TerminalWs] Failed to send terminal_stop for session ${sessionId}:`, err);
      }
    }

    if (options.closeSocket && options.expectedWs) {
      try {
        options.expectedWs.close(options.closeCode, options.closeReason);
      } catch (err) {
        console.error(`[TerminalWs] Failed to close terminal socket for session ${sessionId}:`, err);
      }
    }

    // Final matching ownership check before dropping local state.
    const current = activeTerminalSessions.get(sessionId);
    if (current !== session || !isExactTerminalConnection(current, identity)) return;
    unregisterTerminalOutputCallback(sessionId);
    removeExactLocalRemoteConnection(activeTerminalSessions, sessionId, identity);
    if (provenOwner) {
      await session.sharedLeases.release(session.sharedOwner).catch(() => false);
    }

    if (!mayMutate) return;

    const endedAt = new Date();
    const durationSeconds = Math.round(
      (endedAt.getTime() - session.startedAt.getTime()) / 1000,
    );
    try {
      await withSystemDbAccessContext(async () => {
        await db
          .update(remoteSessions)
          .set({ status: options.terminalStatus, endedAt, durationSeconds })
          .where(eq(remoteSessions.id, sessionId));
      });
    } catch (dbErr) {
      console.error(`[TerminalWs] Failed to update session ${sessionId} on close:`, dbErr);
    }

    if (options.writeSummary) {
      try {
        await logSessionAudit(
          'terminal.session.summary',
          session.userId,
          session.orgId,
          {
            sessionId,
            deviceId: session.deviceId,
            bytesIn: session.bytesIn,
            bytesOut: session.bytesOut,
            durationMs: endedAt.getTime() - session.startedAt.getTime(),
          },
        );
      } catch (auditErr) {
        console.error(`[TerminalWs] Failed to write session summary for ${sessionId}:`, auditErr);
      }
    }

    console.log(
      `Terminal session ${sessionId} closed (${options.closeReason}, duration: ${durationSeconds}s)`,
    );
  })();

  session.cleanupPromise = cleanup;
  await cleanup;
  return true;
}

/**
 * Force-close whichever terminal generation is live on THIS instance: kill the
 * agent PTY (`terminal_stop`), stop the timers, drop the in-memory entry, and
 * close the user socket. Resolves `true` if a live session existed locally (and
 * was closed), `false` if there was nothing to close here (e.g. the socket
 * lives on another API instance, or already ended).
 *
 * Asynchronous because the durable close proof (`beginClose`) is: ownership is
 * a cross-replica fact and cannot be decided from local memory alone. Callers
 * that need to know whether the PTY was signalled must await it.
 *
 * Used by mid-session revocation (the ping loop) and by
 * `remoteSessionTeardown` so a suspended operator / quarantined device cannot
 * keep a live shell relaying input.
 */
export async function closeTerminalSession(sessionId: string): Promise<boolean> {
  const termSession = activeTerminalSessions.get(sessionId);
  if (!termSession) return false;
  return closeExactTerminalConnection(sessionId, identityOf(termSession), {
    expectedWs: termSession.userWs,
    closeSocket: true,
    closeCode: 4003,
    closeReason: 'Session revoked',
    terminalStatus: 'disconnected',
    writeSummary: false,
  });
}

export type TerminalStartFailureOutcome = 'delivered' | 'foreign_agent' | 'unknown_command';

/**
 * Apply a late `terminal_start` failure reported by the agent.
 *
 * The command id embeds the connection generation that dispatched the start,
 * so a failure belonging to a superseded generation can never notify — or tear
 * down — the generation that owns the session now.
 *
 * The three outcomes are deliberately distinct. `foreign_agent` means a live
 * start was claimed by an agent that did not receive it — genuinely suspicious,
 * and the caller counts it as a cross-tenant probe. `unknown_command` is
 * benign: a superseded generation, or a start issued by an API instance that
 * has since restarted or been rolled. Counting those as probes would let an
 * ordinary rolling deploy trip the auto-suspend threshold and disable healthy
 * agents.
 */
export async function failTerminalStartForExactCommand(
  commandId: string,
  agentId: string,
  errorDetail: string,
): Promise<TerminalStartFailureOutcome> {
  for (const [sessionId, session] of activeTerminalSessions) {
    if (session.startCommandId !== commandId) continue;
    if (session.agentId !== agentId) return 'foreign_agent';
    const ws = session.userWs;
    if (!ws) return 'unknown_command';
    try {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'TERMINAL_START_FAILED',
        message: `Agent failed to start terminal: ${errorDetail}`,
      }));
    } catch (sendErr) {
      console.error(
        `[TerminalWs] Failed to notify user of terminal failure for session ${sessionId}:`,
        sendErr,
      );
    }
    await closeExactTerminalConnection(sessionId, identityOf(session), {
      expectedWs: ws,
      closeSocket: true,
      closeCode: 4003,
      closeReason: 'Terminal start failed',
      terminalStatus: 'failed',
      writeSummary: false,
    });
    return 'delivered';
  }
  return 'unknown_command';
}

async function validateTerminalUpgradeContext(
  context: RemoteWsUpgradeContext,
): Promise<Awaited<ReturnType<typeof validateTerminalAccess>>> {
  const result = context.authorizationPhase === 'complete'
    ? { ok: true as const, context: context.authorization }
    : await authorizeConsumedRemoteWsTicket(context.ticket);
  if (!result.ok) {
    return { valid: false, error: result.reason };
  }
  const authorization = result.context;
  return {
    valid: true,
    userId: authorization.userId,
    session: {
      id: authorization.sessionId,
      type: 'terminal',
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
 * Create WebSocket handlers for terminal session
 */
function createTerminalWsHandlers(
  sessionId: string,
  ticket: string | undefined,
  caller: { ip: string; userAgent: string },
  sharedLeases: RemoteWsSharedLeaseManager,
  upgradeContext?: RemoteWsUpgradeContext,
) {
  let validationResult: Awaited<ReturnType<typeof validateTerminalAccess>> | null = null;
  // The exact identity this handler set owns. Every event and captured closure
  // below re-proves it; nothing in this factory may act on session ID alone.
  let connectionIdentity: RemoteConnectionIdentity | null = null;
  const validationPromise = (
    upgradeContext
      ? validateTerminalUpgradeContext(upgradeContext)
      : validateTerminalAccess(sessionId, ticket, caller)
  ).then(result => {
    validationResult = result;
  });
  const releaseOpeningReservation = async () => {
    if (!upgradeContext) return;
    removeExactLocalRemoteConnection(
      activeTerminalSessions,
      sessionId,
      getRemoteWsUpgradeConnection(upgradeContext),
    );
    upgradeContext.sharedClaim.safeForwardingUntilMonotonicMs = 0;
    await sharedLeases.release(upgradeContext.sharedClaim);
  };

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      let validated = false;
      let sessionStored = false;
      let outputCallbackRegistered = false;
      try {
        console.log(`Terminal WebSocket onOpen for session ${sessionId}`);
        await validationPromise;
        console.log(`Terminal validation result:`, validationResult?.valid, validationResult?.error);

        if (!validationResult || !validationResult.valid) {
          await releaseOpeningReservation();
          console.warn(`Terminal WebSocket rejected for session ${sessionId}: ${validationResult?.error}`);
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

        // Check if agent is connected
        console.log(`Checking if agent ${device.agentId} is connected...`);
        if (!isAgentConnected(device.agentId)) {
          await releaseOpeningReservation();
          console.warn(`Agent ${device.agentId} is not connected via WebSocket`);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_OFFLINE',
            message: 'Agent is not connected via WebSocket'
          }));
          ws.close(4002, 'Agent offline');
          return;
        }
        console.log(`Agent ${device.agentId} is connected`);

        // Rate limit user WS connections (E1: Redis-backed, fail-closed)
        if (!upgradeContext && await isUserTerminalWsRateLimited(userId)) {
          console.warn(`Terminal WebSocket rate limited for user ${userId}`);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many connection attempts'
          }));
          ws.close(4029, 'Rate limited');
          return;
        }

        // Acquire the durable owner BEFORE any session state exists. In
        // pre-upgrade mode the middleware already reserved it; in post-upgrade
        // mode this is the first reservation and a loser never installs.
        const acquired = upgradeContext
          ? { ok: true as const, claim: upgradeContext.sharedClaim }
          : await sharedLeases.acquire('terminal', sessionId);
        if (!acquired.ok) {
          // Never overwrite an opening/active/closing owner: a replica that
          // lost the race closes rather than replacing the live session.
          ws.close(acquired.reason === 'already_owned' ? 4009 : 1011, 'Terminal session unavailable');
          return;
        }

        // All validation and shared acquisition passed — safe to touch DB state
        // for this exact connection generation.
        validated = true;

        // Store the terminal session
        const now = Date.now();
        const reserved = upgradeContext ? activeTerminalSessions.get(sessionId) : undefined;
        if (reserved && upgradeContext) {
          Object.assign(reserved, {
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
              reserved
              && reserved.connectionId === acquired.claim.connectionId
              && reserved.generation === acquired.claim.generation
              && reserved.instanceId === acquired.claim.instanceId
              && reserved.leaseToken === acquired.claim.leaseToken
                ? { ok: true as const }
                : { ok: false as const, reason: 'already_owned' as const }
            )
          : installLocalRemoteConnection(
              activeTerminalSessions,
              sessionId,
              acquired.claim,
              (claim): TerminalSession => ({
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
                msgTimestamps: [],
                msgByteTimestamps: [],
                bytesIn: 0,
                bytesOut: 0,
              }),
            );
        if (!installed.ok) {
          await sharedLeases.release(acquired.claim);
          ws.close(4009, 'Terminal session already owned');
          return;
        }

        connectionIdentity = {
          connectionId: acquired.claim.connectionId,
          generation: acquired.claim.generation,
          instanceId: acquired.claim.instanceId,
          leaseToken: acquired.claim.leaseToken,
        };
        const boundIdentity = connectionIdentity;
        if (!bindRemoteConnection(activeTerminalSessions, sessionId, boundIdentity, ws)) {
          removeExactLocalRemoteConnection(activeTerminalSessions, sessionId, boundIdentity);
          await sharedLeases.release(acquired.claim);
          ws.close(1011, 'Terminal session binding failed');
          return;
        }
        sessionStored = true;
        const boundSession = activeTerminalSessions.get(sessionId);
        if (!boundSession) {
          throw new Error('terminal connection missing after bind');
        }

        // Register callback for terminal output (track bytesOut for audit
        // summary). The closure captures the exact identity + socket: an old
        // callback that survived a reopen relays nothing to the new owner.
        registerTerminalOutputCallback(sessionId, (data: string) => {
          try {
            if (!ownsSafeRemoteConnection(activeTerminalSessions, sessionId, boundIdentity, ws)) {
              return;
            }
            const sess = activeTerminalSessions.get(sessionId);
            if (sess) {
              sess.bytesOut += Buffer.byteLength(data, 'utf8');
            }
            ws.send(JSON.stringify({ type: 'output', data }));
          } catch (error) {
            console.error(`Failed to send terminal output to session ${sessionId}:`, error);
          }
        });
        outputCallbackRegistered = true;

        // Keep the durable lease alive only for this exact installed entry. A
        // renewal failure expires forwarding first (inside
        // `renewExactRemoteConnectionLease`) and then tears the socket down, so
        // no frame is relayed past the point where ownership is unproven.
        boundSession.leaseRenewalInterval = setInterval(() => {
          void renewExactRemoteConnectionLease(
            activeTerminalSessions,
            sessionId,
            boundIdentity,
            ws,
            () => sharedLeases.renew(boundSession.sharedOwner),
          ).then((renewed) => {
            if (renewed) return;
            void closeExactTerminalConnection(sessionId, boundIdentity, {
              expectedWs: ws,
              closeSocket: true,
              closeCode: 4003,
              closeReason: 'Lease lost',
              terminalStatus: 'failed',
              writeSummary: false,
            }).catch(() => undefined);
          });
        }, REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS);

        console.log(`Terminal session ${sessionId} connected for device ${device.hostname}`);

        // Update session status
        await withSystemDbAccessContext(async () => {
          await db
            .update(remoteSessions)
            .set({
              status: 'active',
              startedAt: new Date()
            })
            .where(eq(remoteSessions.id, sessionId));
        });

        if (!ownsSafeRemoteConnection(activeTerminalSessions, sessionId, boundIdentity, ws)) {
          await closeExactTerminalConnection(sessionId, boundIdentity, {
            expectedWs: ws,
            closeSocket: true,
            closeCode: 1011,
            closeReason: 'Terminal session setup failed',
            terminalStatus: 'failed',
            writeSummary: false,
          });
          return;
        }

        // Send connected message to user
        ws.send(JSON.stringify({
          type: 'connected',
          sessionId,
          device: {
            hostname: device.hostname,
            osType: device.osType
          }
        }));

        // Send terminal_start command to agent. The command id embeds this
        // generation so a late failure result can only ever be attributed back
        // to the generation that issued it.
        const startCommandId = terminalStartCommandId(sessionId, boundIdentity.generation);
        boundSession.startCommandId = startCommandId;
        const startCommand = {
          id: startCommandId,
          type: 'terminal_start',
          payload: {
            sessionId,
            cols: 80,
            rows: 24,
            shell: device.osType === 'windows' ? 'powershell' : undefined
          }
        };

        const sent = sendCommandToAgent(device.agentId, startCommand);
        if (!sent) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_SEND_FAILED',
            message: 'Failed to send start command to agent'
          }));

          // Clean up: agent is offline, session cannot proceed.
          await closeExactTerminalConnection(sessionId, boundIdentity, {
            expectedWs: ws,
            closeSocket: true,
            closeCode: 4002,
            closeReason: 'Agent send failed',
            terminalStatus: 'failed',
            writeSummary: false,
          });
          return;
        }

        // Start server-side ping/pong for stale connection detection. The timer
        // captures the immutable identity and its expected socket, so a timer
        // that outlives its generation (session removed and reopened) finds no
        // exact owner and does nothing at all.
        const pingInterval = setInterval(() => {
          const termSess = activeTerminalSessions.get(sessionId);
          if (
            !termSess
            || !ownsSafeRemoteConnection(activeTerminalSessions, sessionId, boundIdentity, ws)
          ) {
            clearInterval(pingInterval);
            return;
          }
          const elapsed = Date.now() - termSess.lastPongAt;
          if (elapsed > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
            console.warn(`Terminal session ${sessionId} pong timeout (${elapsed}ms), closing`);
            clearInterval(pingInterval);
            ws.close(4008, 'Pong timeout');
            return;
          }
          // Enforce mid-session revocation on the live socket, mirroring the
          // desktop ping loop. Ticket consumption is the only connect-time auth
          // boundary for a terminal WS, and the user→agent relay re-checks
          // nothing once streaming — so a revoke (operator suspended, device
          // quarantined, session ended elsewhere) would otherwise keep a live
          // shell relaying input until pong timeout, or indefinitely while the
          // client answers pings. This is the cross-instance backstop to the
          // direct socket close done by `closeTerminalSession`. A revoked socket
          // closes within at most one ping interval (PING_INTERVAL_MS). Fails CLOSED.
          void isViewerSessionRevoked(sessionId)
            .then((revoked) => {
              if (
                revoked
                && ownsSafeRemoteConnection(activeTerminalSessions, sessionId, boundIdentity, ws)
              ) {
                console.warn(`[TerminalWs] Session ${sessionId} revoked mid-session, closing socket`);
                clearInterval(pingInterval);
                void closeExactTerminalConnection(sessionId, boundIdentity, {
                  expectedWs: ws,
                  closeSocket: true,
                  closeCode: 4003,
                  closeReason: 'Session revoked',
                  terminalStatus: 'disconnected',
                  writeSummary: false,
                }).catch(() => undefined);
              }
            })
            .catch((revErr) => {
              // A thrown rejection (not just Redis-down, which resolves `true`)
              // must also fail CLOSED — tear the socket down rather than leave
              // it relaying on an unhandled rejection.
              console.error(
                `[TerminalWs] Revocation check failed for session ${sessionId}, closing socket (fail-closed):`,
                revErr
              );
              clearInterval(pingInterval);
              if (ownsSafeRemoteConnection(activeTerminalSessions, sessionId, boundIdentity, ws)) {
                void closeExactTerminalConnection(sessionId, boundIdentity, {
                  expectedWs: ws,
                  closeSocket: true,
                  closeCode: 4003,
                  closeReason: 'Session revoked',
                  terminalStatus: 'disconnected',
                  writeSummary: false,
                }).catch(() => undefined);
              }
            });
          try {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          } catch (err) {
            console.warn(`[TerminalWs] Ping send failed for session ${sessionId}, cleaning up`, err);
            clearInterval(pingInterval);
          }
        }, PING_INTERVAL_MS);

        // Attach the timer only to the exact entry this handler owns.
        const currentSession = activeTerminalSessions.get(sessionId);
        if (currentSession && isExactTerminalConnection(currentSession, boundIdentity)) {
          currentSession.pingInterval = pingInterval;
        } else {
          clearInterval(pingInterval);
        }
      } catch (error) {
        console.error(`[TerminalWs] onOpen failed for session ${sessionId}:`, error);

        // Clean up only the state THIS generation created.
        if (sessionStored && connectionIdentity) {
          await closeExactTerminalConnection(sessionId, connectionIdentity, {
            expectedWs: ws,
            closeSocket: false,
            closeCode: 4001,
            closeReason: 'Session setup failed',
            terminalStatus: 'failed',
            writeSummary: false,
          }).catch((cleanupError) => {
            console.error(`[TerminalWs] setup cleanup failed for ${sessionId}:`, cleanupError);
            return false;
          });
        } else {
          if (outputCallbackRegistered) unregisterTerminalOutputCallback(sessionId);
          await releaseOpeningReservation();

          // Best-effort: mark DB session as failed — only if auth/validation already passed
          if (validated) {
            try {
              await withSystemDbAccessContext(async () => {
                await db
                  .update(remoteSessions)
                  .set({ status: 'failed', endedAt: new Date() })
                  .where(eq(remoteSessions.id, sessionId));
              });
            } catch (dbError) {
              console.error(`[TerminalWs] Failed to update session ${sessionId} status to failed:`, dbError);
            }
          }
        }

        try {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INTERNAL_ERROR',
            message: 'Terminal session setup failed'
          }));
          ws.close(4001, 'Session setup failed');
        } catch (closeError) {
          console.error(`[TerminalWs] Failed to close WS after onOpen error for session ${sessionId}:`, closeError);
        }
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const termSession = activeTerminalSessions.get(sessionId);
      if (!termSession) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Terminal session not found'
        }));
        return;
      }
      // Ownership before anything else: a foreign socket, a socket from a
      // replaced generation, or an expired forwarding deadline gets no reply,
      // no agent command, no pong-time update, and no rate-limit accounting.
      if (
        !connectionIdentity
        || !ownsSafeRemoteConnection(activeTerminalSessions, sessionId, connectionIdentity, ws)
      ) {
        return;
      }

      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const raw = JSON.parse(data);

        // Handle pong responses for server-initiated ping (not in discriminatedUnion)
        if (raw?.type === 'pong') {
          termSession.lastPongAt = Date.now();
          return;
        }

        const parsed = terminalMessageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn(`Invalid terminal message from session ${sessionId}:`, parsed.error.issues);
          return;
        }
        const message = parsed.data;

        switch (message.type) {
          case 'data': {
            // E2: Per-session input rate limiting (200 msgs/min OR 1MB/min).
            // On breach: close session with policy-violation code 1008 and
            // emit a rate-limit audit log.
            const nowMs = Date.now();
            const cutoff = nowMs - TERMINAL_MSG_WINDOW_MS;
            termSession.msgTimestamps = termSession.msgTimestamps.filter(t => t > cutoff);
            termSession.msgByteTimestamps = termSession.msgByteTimestamps.filter(e => e.ts > cutoff);

            const incomingBytes = Buffer.byteLength(message.data, 'utf8');
            termSession.msgTimestamps.push(nowMs);
            termSession.msgByteTimestamps.push({ ts: nowMs, bytes: incomingBytes });
            termSession.bytesIn += incomingBytes;

            const totalBytes = termSession.msgByteTimestamps.reduce((acc, e) => acc + e.bytes, 0);
            if (
              termSession.msgTimestamps.length > TERMINAL_MSG_LIMIT ||
              totalBytes > TERMINAL_BYTES_LIMIT
            ) {
              console.warn(
                `Terminal session ${sessionId} input rate-limited (msgs=${termSession.msgTimestamps.length}, bytes=${totalBytes})`
              );
              try {
                ws.send(JSON.stringify({
                  type: 'error',
                  code: 'INPUT_RATE_LIMITED',
                  message: 'Input rate limit exceeded'
                }));
              } catch {
                // best-effort
              }
              ws.close(1008, 'input_rate_limited');
              return;
            }

            // Send terminal input to agent
            sendCommandToAgent(termSession.agentId, {
              id: nextTerminalCommandId('data'),
              type: 'terminal_data',
              payload: {
                sessionId,
                data: message.data
              }
            });
            break;
          }

          case 'resize':
            // Send resize command to agent
            sendCommandToAgent(termSession.agentId, {
              id: nextTerminalCommandId('resize'),
              type: 'terminal_resize',
              payload: {
                sessionId,
                cols: message.cols,
                rows: message.rows
              }
            });
            break;

          case 'ping':
            // Client-initiated ping — respond with pong and update timestamp
            termSession.lastPongAt = Date.now();
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }
      } catch (error) {
        console.error(`Error processing terminal message for session ${sessionId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

    onClose: async (_event: unknown, ws: WSContext) => {
      // A close event from a foreign or superseded socket must not tear down
      // the live owner — it reaches no exact entry and no-ops.
      if (!connectionIdentity) return;
      await closeExactTerminalConnection(sessionId, connectionIdentity, {
        expectedWs: ws,
        closeSocket: false,
        closeCode: 1000,
        closeReason: 'disconnected',
        terminalStatus: 'disconnected',
        writeSummary: true,
      });
    },

    onError: async (event: unknown, ws: WSContext) => {
      console.error(`Terminal WebSocket error for session ${sessionId}:`, event);
      if (!connectionIdentity) return;
      await closeExactTerminalConnection(sessionId, connectionIdentity, {
        expectedWs: ws,
        closeSocket: false,
        closeCode: 1011,
        closeReason: 'socket_error',
        terminalStatus: 'disconnected',
        writeSummary: false,
      });
    }
  };
}

/**
 * Create terminal WebSocket routes
 */
export function createTerminalWsRoutes(
  upgradeWebSocket: Function,
  options: { sharedLeases?: RemoteWsSharedLeaseManager } = {},
): Hono {
  assertRemoteWsUpgradeRuntimeReady();
  const app = new Hono();

  // WebSocket route for terminal sessions
  // GET /api/v1/remote/sessions/:id/ws?ticket=xxx
  app.get(
    '/:id/ws',
    async (c, next) => {
      const sharedLeases = options.sharedLeases ?? getRemoteWsSharedLeaseManager();
      if (!sharedLeases) {
        return c.json({ error: 'Remote ownership unavailable' }, 503);
      }
      return requireRemoteWsUpgrade({
        expectedType: 'terminal',
        sharedLeases,
        // Reject implicit replacement BEFORE the 101: any installed entry —
        // opening, active, or closing — makes this a 409, never an overwrite.
        // No replica relies on a post-upgrade 4009 close as enforcement.
        installLocal: (sessionId, claim) => {
          const now = Date.now();
          return installLocalRemoteConnection(
            activeTerminalSessions,
            sessionId,
            claim,
            (shared): TerminalSession => ({
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
              msgTimestamps: [],
              msgByteTimestamps: [],
              bytesIn: 0,
              bytesOut: 0,
            }),
          );
        },
        removeLocal: (sessionId, claim) =>
          removeExactLocalRemoteConnection(activeTerminalSessions, sessionId, claim),
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
      // Bind ticket consumption to the upgrade request's trusted IP + UA
      // (Task 16) — a stolen 60-second ticket consumed from a different
      // network position is rejected.
      const caller = {
        ip: getTrustedClientIp(c as Parameters<typeof getTrustedClientIp>[0]),
        userAgent: c.req.header('user-agent') ?? '',
      };
      const sharedLeases = options.sharedLeases ?? getRemoteWsSharedLeaseManager();
      if (!sharedLeases) {
        // Fail closed: without the durable owner there is no way to prove this
        // socket owns the session, and an unproven terminal must not stream.
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
      return createTerminalWsHandlers(sessionId, ticket, caller, sharedLeases, context);
    })
  );

  return app;
}

/**
 * Get count of active terminal sessions
 */
export function getActiveTerminalSessionCount(): number {
  return activeTerminalSessions.size;
}

/**
 * Get all active terminal session IDs
 */
export function getActiveTerminalSessionIds(): string[] {
  return Array.from(activeTerminalSessions.keys());
}

export function __resetTerminalWsForTest(): void {
  for (const session of activeTerminalSessions.values()) {
    if (session.pingInterval) clearInterval(session.pingInterval);
    if (session.leaseRenewalInterval) clearInterval(session.leaseRenewalInterval);
  }
  activeTerminalSessions.clear();
  terminalOutputCallbacks.clear();
}

// Monotonic across every test manager instance, mirroring the real Redis
// `INCR`: two generations must never share an identity, or a stale-generation
// test would pass for the wrong reason.
let testLeaseGeneration = 0;

/**
 * In-memory stand-in for the Redis-backed lease manager. Generations increment
 * exactly as the real `INCR` does, so tests exercise real generation-mismatch
 * behaviour rather than a permissive stub.
 */
export function __createTerminalSharedLeasesForTest(): RemoteWsSharedLeaseManager {
  const owners = new Map<string, string>();
  let generation = 0;
  return {
    acquire: async (kind, sessionId) => {
      if (owners.has(sessionId)) return { ok: false, reason: 'already_owned' };
      testLeaseGeneration += 1;
      generation = testLeaseGeneration;
      const claim: RemoteWsSharedLeaseClaim = {
        kind,
        sessionId,
        connectionId: `11111111-1111-4111-8111-${String(generation).padStart(12, '0')}`,
        generation,
        instanceId: '22222222-2222-4222-8222-222222222222',
        leaseToken: `33333333-3333-4333-8333-${String(generation).padStart(12, '0')}`,
        ownerValue: `test-owner-${generation}`,
        safeForwardingUntilMonotonicMs: Number.MAX_SAFE_INTEGER,
      };
      owners.set(sessionId, claim.ownerValue);
      return { ok: true, claim };
    },
    renew: async (claim) => claim,
    beginClose: async (claim) => (
      owners.get(claim.sessionId) === claim.ownerValue
        ? { ok: true, ownership: 'still_owner' }
        : { ok: false, reason: 'owner_mismatch' }
    ),
    release: async (claim) => {
      if (owners.get(claim.sessionId) !== claim.ownerValue) return false;
      owners.delete(claim.sessionId);
      return true;
    },
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
