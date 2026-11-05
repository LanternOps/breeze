import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { remoteSessions } from '../db/schema';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';
import { getRedis } from './redis';
import { commitDesktopTerminalIntent } from './remoteDesktopTerminalIntent';
import { captureException } from './sentry';
import { revokeViewerSession } from './viewerTokenRevocation';

/**
 * #10542: a short hold on a desktop peer drop that the viewer's own
 * reconnect caused.
 *
 * When the viewer's WebRTC connection goes `disconnected`, the viewer closes
 * its old peer and starts a reconnect: it fetches ICE servers, then posts a new
 * offer. Closing the old peer makes the agent report `peer_disconnected`, and
 * that report used to end the session and revoke the viewer token at once
 * (Finding #5). Every reconnect offer then got a 401.
 *
 * A peer drop still ends the session at once, unless the viewer fetched ICE
 * servers for this live session within the last
 * DESKTOP_RECONNECT_INTENT_WINDOW_MS. In that case the end (terminal commit +
 * viewer-token revocation) waits DESKTOP_RECONNECT_GRACE_MS, and then happens
 * only if the session is still on the start the drop interrupted. A reconnect
 * offer commits a new start (it bumps `desktop_start_generation`), so the held
 * end matches nothing and the session continues.
 *
 * The hold is bounded on every instance, not just the one holding the timer:
 *  - The timer lives on the API instance that holds the agent's socket.
 *  - A durable record (start generation + deadline) is written to Redis before
 *    the hold starts. validateViewerSessionAccess calls
 *    enforceExpiredDesktopReconnectHold, so once the deadline has passed any
 *    instance ends the session before it serves that viewer token again, even
 *    if the holding instance died and its timer was lost.
 *  - If the record cannot be written, there is no hold: the session ends at
 *    once, as before.
 *
 * The hold ends early when the person at the device ends the session
 * (endHeldDesktopSessionNow). An End from the dashboard commits the terminal
 * state itself, so the held end then matches no live row and does nothing.
 */

/** Same as the agent's ICE-disconnected grace (agent/internal/remote/desktop/session_webrtc.go). */
export const DESKTOP_RECONNECT_GRACE_MS = 20_000;

/**
 * How long an ICE-server fetch counts as "a reconnect is in flight". The
 * viewer fetches ICE servers right after it closes the old peer, and the
 * agent's drop report normally follows within a second.
 */
export const DESKTOP_RECONNECT_INTENT_WINDOW_MS = 10_000;

function intentKey(sessionId: string): string {
  return `desktop-viewer-reconnect:${sessionId}`;
}

function holdKey(sessionId: string): string {
  return `desktop-reconnect-hold:${sessionId}`;
}

/**
 * Record that the viewer is renegotiating this session. Returns false when the
 * mark could not be written; then a following peer drop ends the session at
 * once, which is the behavior before #10542.
 */
export async function markDesktopViewerReconnectIntent(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(intentKey(sessionId), '1', 'PX', DESKTOP_RECONNECT_INTENT_WINDOW_MS);
    return true;
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to record viewer reconnect intent:', err);
    return false;
  }
}

/**
 * Take the reconnect mark for this session, if there is one. Atomic (GETDEL),
 * so one ICE-server fetch allows at most one hold. Any failure returns false,
 * so the drop ends the session at once.
 */
export async function consumeDesktopViewerReconnectIntent(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return (await redis.getdel(intentKey(sessionId))) === '1';
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to read viewer reconnect intent:', err);
    return false;
  }
}

async function clearHoldRecord(sessionId: string): Promise<void> {
  try {
    await getRedis()?.del(holdKey(sessionId));
  } catch (err) {
    // Harmless: a leftover record names a start that has ended, so it no
    // longer matches a live session, and it expires with the viewer token.
    console.error('[desktopReconnectGrace] Failed to clear reconnect hold record:', err);
  }
}

export type HeldDesktopSessionEndOutcome = 'ended' | 'superseded';

/**
 * The end a peer drop would have done at once: mark the session
 * `disconnected` and revoke the viewer token (Finding #5), but only while the
 * session is still `active` on the start the drop interrupted. 'superseded'
 * means a reconnect committed a newer start, or the session already ended some
 * other way.
 */
export async function endDesktopSessionAfterReconnectGrace(input: {
  sessionId: string;
  deviceId: string;
  startGeneration: bigint;
}): Promise<HeldDesktopSessionEndOutcome> {
  const result = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      commitDesktopTerminalIntent({
        sessionId: input.sessionId,
        write: { status: 'disconnected', endedAt: new Date() },
        // The agent already stopped this peer: nothing left to acknowledge.
        phase: 'confirmed',
        where: [
          eq(remoteSessions.deviceId, input.deviceId),
          eq(remoteSessions.status, 'active'),
          eq(remoteSessions.desktopStartGeneration, input.startGeneration),
        ],
      }),
    ),
  );
  if (!result.ok) {
    await clearHoldRecord(input.sessionId);
    return 'superseded';
  }
  await revokeViewerSession(input.sessionId);
  await clearHoldRecord(input.sessionId);
  console.log(`[desktopReconnectGrace] Session ${input.sessionId} marked disconnected (peer dropped; no reconnect within the grace)`);
  return 'ended';
}

interface HeldSession {
  deviceId: string;
  startGeneration: bigint;
  timer: ReturnType<typeof setTimeout>;
  end: () => Promise<void>;
}

const heldSessions = new Map<string, HeldSession>();

async function runEnd(sessionId: string, end: () => Promise<void>): Promise<void> {
  try {
    await end();
  } catch (err) {
    console.error(`[desktopReconnectGrace] Failed to end session ${sessionId} after the reconnect grace:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

interface HoldRecord {
  deviceId: string;
  startGeneration: string;
  deadlineMs: number;
}

export type HoldDesktopSessionOutcome = 'held' | 'already_held' | 'unavailable';

/**
 * Hold this session's end for the grace. 'unavailable' means the durable
 * record could not be written and nothing is held: the caller must end the
 * session now.
 *
 * A second drop for the same start does not extend the hold. A drop for a
 * newer start replaces the older hold, because the older start is already
 * superseded.
 */
export async function holdDesktopSessionForReconnect(input: {
  sessionId: string;
  deviceId: string;
  startGeneration: bigint;
  graceMs?: number;
}): Promise<HoldDesktopSessionOutcome> {
  const existing = heldSessions.get(input.sessionId);
  if (existing && existing.startGeneration >= input.startGeneration) return 'already_held';

  const graceMs = input.graceMs ?? DESKTOP_RECONNECT_GRACE_MS;
  const record: HoldRecord = {
    deviceId: input.deviceId,
    startGeneration: input.startGeneration.toString(),
    deadlineMs: Date.now() + graceMs,
  };
  const redis = getRedis();
  if (!redis) return 'unavailable';
  try {
    // Kept as long as any viewer token for this session can live, so the
    // deadline is enforceable for the token's whole life.
    await redis.set(holdKey(input.sessionId), JSON.stringify(record), 'EX', VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS);
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to record reconnect hold; ending the session now:', err);
    return 'unavailable';
  }

  // Re-read after the await: another drop may have installed a hold meanwhile.
  const current = heldSessions.get(input.sessionId);
  if (current) {
    if (current.startGeneration >= input.startGeneration) return 'already_held';
    clearTimeout(current.timer);
    heldSessions.delete(input.sessionId);
  }

  const end = async () => {
    await endDesktopSessionAfterReconnectGrace({
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      startGeneration: input.startGeneration,
    });
  };
  const held: HeldSession = {
    deviceId: input.deviceId,
    startGeneration: input.startGeneration,
    end,
    timer: setTimeout(() => {
      if (heldSessions.get(input.sessionId) !== held) return;
      heldSessions.delete(input.sessionId);
      void runEnd(input.sessionId, end);
    }, graceMs),
  };
  held.timer.unref?.();
  heldSessions.set(input.sessionId, held);
  return 'held';
}

/**
 * End a held session now instead of when the grace runs out. Used when the
 * person at the device ended the session; bound to that device, so one agent
 * cannot cut short a hold on another device's session. Returns false when
 * nothing was held for that device on this instance.
 */
export async function endHeldDesktopSessionNow(sessionId: string, deviceId: string): Promise<boolean> {
  const held = heldSessions.get(sessionId);
  if (!held || held.deviceId !== deviceId) return false;
  clearTimeout(held.timer);
  heldSessions.delete(sessionId);
  await runEnd(sessionId, held.end);
  return true;
}

export function isDesktopSessionHeldForReconnect(sessionId: string): boolean {
  return heldSessions.has(sessionId);
}

export type PeerDropDecision = 'held' | 'end_now';

/**
 * The agent reported a peer drop for this session. Decide whether its end
 * waits for a viewer reconnect ('held') or happens now ('end_now', the
 * Finding #5 behavior, which the caller performs).
 *
 * Held only when all of these hold; anything else, including any error, ends
 * the session now:
 *  - the agent gave no stop reason (a reason means the agent stopped the
 *    session on purpose, e.g. the no-video watchdog);
 *  - the session is not a WebSocket-relay stream owned by this agent;
 *  - the viewer fetched ICE servers for this session within the intent window
 *    (the mark is consumed, so one fetch allows one hold);
 *  - the session is still `active` on this device, with no terminal phase and
 *    no end reason (the person at the device did not end it);
 *  - the durable hold record was written.
 */
export async function holdDesktopPeerDropForReconnect(input: {
  sessionId: string;
  deviceId: string;
  stopReason: string | null;
  relayOwned: boolean;
}): Promise<PeerDropDecision> {
  if (input.stopReason || input.relayOwned) return 'end_now';
  if (!(await consumeDesktopViewerReconnectIntent(input.sessionId))) return 'end_now';

  let row: { status: string; endReason: string | null; terminationPhase: string; desktopStartGeneration: bigint } | undefined;
  try {
    [row] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({
            status: remoteSessions.status,
            endReason: remoteSessions.endReason,
            terminationPhase: remoteSessions.terminationPhase,
            desktopStartGeneration: remoteSessions.desktopStartGeneration,
          })
          .from(remoteSessions)
          .where(and(eq(remoteSessions.id, input.sessionId), eq(remoteSessions.deviceId, input.deviceId)))
          .limit(1),
      ),
    );
  } catch (err) {
    console.error(`[desktopReconnectGrace] Failed to read session ${input.sessionId} for a reconnect hold; ending it now:`, err);
    return 'end_now';
  }
  if (!row || row.status !== 'active' || row.endReason !== null || (row.terminationPhase ?? 'none') !== 'none') {
    return 'end_now';
  }

  const outcome = await holdDesktopSessionForReconnect({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    startGeneration: BigInt(row.desktopStartGeneration),
  });
  return outcome === 'unavailable' ? 'end_now' : 'held';
}

export type ExpiredHoldEnforcement = 'none' | 'ended' | 'unavailable';

/**
 * Called before a viewer token is honoured. 'ended' means this session was
 * held, its deadline passed, and it has now been ended (the caller refuses the
 * request as for any ended session). 'unavailable' means the record could not
 * be read and the caller must not serve the request.
 */
export async function enforceExpiredDesktopReconnectHold(
  session: { id: string; deviceId: string; desktopStartGeneration: bigint },
  nowMs: number = Date.now(),
): Promise<ExpiredHoldEnforcement> {
  const redis = getRedis();
  if (!redis) return 'unavailable';
  let raw: string | null;
  try {
    raw = await redis.get(holdKey(session.id));
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to read reconnect hold record:', err);
    return 'unavailable';
  }
  if (raw === null) return 'none';

  let record: HoldRecord | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<HoldRecord>;
    if (typeof parsed.startGeneration === 'string' && typeof parsed.deadlineMs === 'number') {
      record = parsed as HoldRecord;
    }
  } catch {
    record = null;
  }
  if (record) {
    // A reconnect committed a newer start: the hold no longer applies.
    if (record.startGeneration !== session.desktopStartGeneration.toString()) return 'none';
    if (nowMs < record.deadlineMs) return 'none';
  } else {
    console.error(`[desktopReconnectGrace] Unreadable reconnect hold record for session ${session.id}; ending the session`);
  }

  await endDesktopSessionAfterReconnectGrace({
    sessionId: session.id,
    deviceId: session.deviceId,
    startGeneration: session.desktopStartGeneration,
  });
  return 'ended';
}

export function __resetDesktopReconnectGraceForTest(): void {
  for (const held of heldSessions.values()) clearTimeout(held.timer);
  heldSessions.clear();
}
