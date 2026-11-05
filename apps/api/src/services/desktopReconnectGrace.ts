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
 * When the viewer's WebRTC connection goes `disconnected`, the viewer
 * reconnects: it closes its old peer, fetches ICE servers and posts a new
 * offer. Closing the old peer drives the agent's peer to Closed/Failed, and
 * the agent reports `peer_disconnected` at once. That report used to end the
 * session and revoke the viewer token immediately (Finding #5), so every
 * reconnect offer got a 401.
 *
 * The viewer now marks the reconnect before it closes the old peer, by
 * fetching ICE servers for the still-active session (older viewers fetch only
 * after the close, so their mark usually, but not always, lands before the
 * drop report). The mark names the start generation the session was on. A
 * peer drop for that same start, within DESKTOP_RECONNECT_INTENT_WINDOW_MS,
 * holds the end (terminal commit + viewer-token revocation) for
 * DESKTOP_RECONNECT_GRACE_MS. When the grace runs out the session ends only if
 * it is still on that start. The reconnect offer commits a new start (it bumps
 * `desktop_start_generation`), so the held end matches nothing and the session
 * continues. Every other drop ends the session at once, as before.
 *
 * The hold is bounded on every instance, not just the one holding the timer:
 *  - The timer lives on the API instance that holds the agent's socket.
 *  - A durable record (start generation + deadline) is written to Redis before
 *    the hold counts. validateViewerSessionAccess calls
 *    enforceExpiredDesktopReconnectHold, so once the deadline has passed any
 *    instance ends the session before it serves that viewer token again, even
 *    if the holding instance died and its timer was lost.
 *  - If the record cannot be written, there is no hold: the session ends at
 *    once.
 *
 * The hold ends early when the person at the device ends the session
 * (endHeldDesktopSessionNow, on the instance holding it). An End from the
 * dashboard commits the terminal state itself, so the held end then matches no
 * live row and does nothing.
 */

/**
 * Matches the agent's 20 s ICE-disconnected grace timer
 * (agent/internal/remote/desktop/session_webrtc.go, the
 * PeerConnectionStateDisconnected branch). Keep the two in step.
 */
export const DESKTOP_RECONNECT_GRACE_MS = 20_000;

/**
 * How long a reconnect mark stays valid. The drop it is waiting for follows
 * the viewer closing its old peer, which the agent reports as soon as its
 * peer reaches Closed/Failed. A drop that only comes from the agent's own 20 s
 * disconnected timer arrives after this window and ends the session at once.
 */
export const DESKTOP_RECONNECT_INTENT_WINDOW_MS = 10_000;

/** Delay between attempts when a held end fails (DB or Redis blip). */
export const DESKTOP_RECONNECT_END_RETRY_MS = 5_000;
const DESKTOP_RECONNECT_END_ATTEMPTS = 3;

function intentKey(sessionId: string): string {
  return `desktop-viewer-reconnect:${sessionId}`;
}

function holdKey(sessionId: string): string {
  return `desktop-reconnect-hold:${sessionId}`;
}

function report(err: unknown, sessionId: string, where: string): void {
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
    area: 'desktopReconnectGrace',
    where,
    desktopSessionId: sessionId,
  });
}

/**
 * Record that the viewer is renegotiating this session, which is on
 * `startGeneration`. Returns false when the mark could not be written; then a
 * following peer drop ends the session at once, as before #10542.
 */
export async function markDesktopViewerReconnectIntent(
  sessionId: string,
  startGeneration: bigint,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(intentKey(sessionId), startGeneration.toString(), 'PX', DESKTOP_RECONNECT_INTENT_WINDOW_MS);
    return true;
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to record viewer reconnect intent:', err);
    return false;
  }
}

/**
 * Take the reconnect mark for this session, if there is one, and return the
 * start generation it names. Atomic (GETDEL), so one mark allows at most one
 * hold. Any failure returns null, so the drop ends the session at once.
 */
export async function consumeDesktopViewerReconnectIntent(sessionId: string): Promise<bigint | null> {
  const redis = getRedis();
  if (!redis) return null;
  let raw: string | null;
  try {
    raw = await redis.getdel(intentKey(sessionId));
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to read viewer reconnect intent:', err);
    return null;
  }
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

async function clearHoldRecord(sessionId: string): Promise<void> {
  try {
    await getRedis()?.del(holdKey(sessionId));
  } catch (err) {
    // Harmless: a leftover record names a start the session is no longer on
    // (or a session that is no longer live), so enforcement ignores it, and
    // its TTL removes it.
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
  record: string;
  timer: ReturnType<typeof setTimeout>;
  end: () => Promise<void>;
}

const heldSessions = new Map<string, HeldSession>();
const pendingRetries = new Set<ReturnType<typeof setTimeout>>();

/**
 * Run a held end. A failure (DB or Redis blip) is reported and retried a
 * bounded number of times; the durable hold record stays in place until an
 * attempt succeeds, so enforcement still covers the session meanwhile.
 */
async function runEnd(sessionId: string, end: () => Promise<void>, attempt = 1): Promise<void> {
  try {
    await end();
  } catch (err) {
    console.error(
      `[desktopReconnectGrace] Failed to end session ${sessionId} after the reconnect grace (attempt ${attempt}/${DESKTOP_RECONNECT_END_ATTEMPTS}):`,
      err,
    );
    report(err, sessionId, 'held_end');
    if (attempt < DESKTOP_RECONNECT_END_ATTEMPTS) {
      const retry = setTimeout(() => {
        pendingRetries.delete(retry);
        void runEnd(sessionId, end, attempt + 1);
      }, DESKTOP_RECONNECT_END_RETRY_MS);
      retry.unref?.();
      pendingRetries.add(retry);
    }
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
 * superseded. The local entry is installed before the record is written, so
 * two drops handled concurrently on this instance cannot leave the record
 * naming the older start.
 */
export async function holdDesktopSessionForReconnect(input: {
  sessionId: string;
  deviceId: string;
  startGeneration: bigint;
  graceMs?: number;
}): Promise<HoldDesktopSessionOutcome> {
  const existing = heldSessions.get(input.sessionId);
  if (existing && existing.startGeneration >= input.startGeneration) return 'already_held';
  const redis = getRedis();
  if (!redis) return 'unavailable';

  if (existing) {
    clearTimeout(existing.timer);
    heldSessions.delete(input.sessionId);
  }

  const graceMs = input.graceMs ?? DESKTOP_RECONNECT_GRACE_MS;
  const end = async () => {
    await endDesktopSessionAfterReconnectGrace({
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      startGeneration: input.startGeneration,
    });
  };
  const record: HoldRecord = {
    deviceId: input.deviceId,
    startGeneration: input.startGeneration.toString(),
    deadlineMs: Date.now() + graceMs,
  };
  const held: HeldSession = {
    deviceId: input.deviceId,
    startGeneration: input.startGeneration,
    record: JSON.stringify(record),
    end,
    timer: setTimeout(() => {
      if (heldSessions.get(input.sessionId) !== held) return;
      heldSessions.delete(input.sessionId);
      void runEnd(input.sessionId, end);
    }, graceMs),
  };
  held.timer.unref?.();
  heldSessions.set(input.sessionId, held);

  try {
    // Kept for a full viewer-token lifetime from now, so the deadline stays
    // enforceable for as long as any token for this session can be used.
    await redis.set(holdKey(input.sessionId), held.record, 'EX', VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS);
    // A newer hold replaced this one while the write was in flight, and this
    // write may have landed after the newer one's. Write the current hold's
    // record again so the record names the newest start.
    const current = heldSessions.get(input.sessionId);
    if (current && current !== held) {
      await redis.set(holdKey(input.sessionId), current.record, 'EX', VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS);
    }
  } catch (err) {
    console.error('[desktopReconnectGrace] Failed to record reconnect hold; ending the session now:', err);
    if (heldSessions.get(input.sessionId) === held) {
      clearTimeout(held.timer);
      heldSessions.delete(input.sessionId);
    }
    return 'unavailable';
  }
  return 'held';
}

/**
 * End a held session now instead of when the grace runs out. Used when the
 * person at the device ended the session; bound to that device, so one agent
 * cannot cut short a hold on another device's session. Returns false when
 * nothing was held for that device on this instance. A failed end is retried
 * as for the timer.
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
 *  - the viewer marked a reconnect within the intent window (the mark is
 *    consumed, so one mark allows one hold);
 *  - the session is still `active` on this device, with no terminal phase and
 *    no recorded end reason (a user end reported after this point cancels the
 *    hold through endHeldDesktopSessionNow);
 *  - the session is still on the start the mark named. A drop handled after
 *    the reconnect offer already committed a newer start is a late report for
 *    the old peer and is not held;
 *  - the durable hold record was written.
 */
export async function holdDesktopPeerDropForReconnect(input: {
  sessionId: string;
  deviceId: string;
  stopReason: string | null;
  relayOwned: boolean;
}): Promise<PeerDropDecision> {
  if (input.stopReason || input.relayOwned) return 'end_now';
  const markedGeneration = await consumeDesktopViewerReconnectIntent(input.sessionId);
  if (markedGeneration === null) return 'end_now';

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
    report(err, input.sessionId, 'hold_read');
    return 'end_now';
  }
  if (!row || row.status !== 'active' || row.endReason !== null || (row.terminationPhase ?? 'none') !== 'none') {
    return 'end_now';
  }
  const startGeneration = BigInt(row.desktopStartGeneration);
  if (startGeneration !== markedGeneration) return 'end_now';

  const outcome = await holdDesktopSessionForReconnect({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    startGeneration,
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
    // Fail closed: a record we cannot read cannot prove its deadline.
    const err = new Error(`Unreadable reconnect hold record for session ${session.id}`);
    console.error(`[desktopReconnectGrace] ${err.message}; ending the session`);
    report(err, session.id, 'hold_record_unreadable');
  }

  const outcome = await endDesktopSessionAfterReconnectGrace({
    sessionId: session.id,
    deviceId: session.deviceId,
    startGeneration: session.desktopStartGeneration,
  });
  // 'superseded': a reconnect committed a newer start (or the session ended
  // another way) between the caller's read and this end. Nothing to refuse
  // here; the caller's own status checks apply.
  return outcome === 'ended' ? 'ended' : 'none';
}

export function __resetDesktopReconnectGraceForTest(): void {
  for (const held of heldSessions.values()) clearTimeout(held.timer);
  heldSessions.clear();
  for (const retry of pendingRetries) clearTimeout(retry);
  pendingRetries.clear();
}
