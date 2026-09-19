/**
 * SEC-038 W02 (#5533) — the single serialized start decision for a remote
 * desktop session.
 *
 * Three sites publish a desktop start today (`POST /remote/sessions/:id/offer`,
 * `POST /desktop-ws/:id/viewer/offer`, and the WS fallback
 * `desktop_stream_start`). Before this wave each of them wrote its offer with a
 * bare status-guarded `UPDATE` and then `await`ed further work — audit write,
 * lease mint — before the command actually went out. A terminal decision
 * committed inside that window won the database row but could still lose the
 * wire, and the agent had no way to tell the two apart.
 *
 * Every start now commits through `commitDesktopStartIntent` /
 * `commitDesktopStreamStartIntent`, which:
 *
 *   1. take a row lock (`SELECT … FOR UPDATE`) on the session,
 *   2. refuse unless `termination_phase = 'none'` and the status is live,
 *   3. bump `desktop_start_generation` — the monotonic total order that W03's
 *      terminal-intent commit bumps too — and write the offer/identity,
 *   4. return the generation the caller must carry in the `start_desktop`
 *      payload.
 *
 * Immediately before the command is handed to the agent the caller re-reads
 * with `assertDesktopStartIntentCurrent`. That narrows the publish window to
 * microseconds; it does NOT close it, and it is not meant to — closing it is
 * the endpoint's job in W04/W05.
 *
 * **How much the re-read can actually see depends on the caller's transaction
 * boundary, and the three start sites differ.** `authMiddleware` wraps a JWT
 * route handler in ONE `withDbAccessContext` transaction, so on
 * `POST /remote/sessions/:id/offer` the row lock is held until the response is
 * produced: a concurrent End blocks instead of interleaving, and the re-read
 * there is a belt-and-braces check against a same-transaction change rather
 * than a genuine race detector. The two `desktopWs` sites run outside that
 * middleware and open their own `withSystemDbAccessContext` per operation, so
 * the lock is released at the commit and the re-read there does catch a real
 * cross-connection terminal. Both shapes are exercised in
 * `src/__tests__/integration/remoteDesktopStartFence.integration.test.ts`,
 * whose header documents the distinction in full.
 *
 * **Generations never pass through a JavaScript `Number`.** They are `bigint`
 * in storage and in this module, and `formatDesktopGeneration` renders the
 * canonical decimal string that travels on the wire.
 *
 * Every entry point must run inside an existing db access context: that context
 * IS the transaction (see `withDbAccessContext`), so the row lock and the write
 * are atomic only while one is open. Calling without one would silently
 * downgrade the lock to a no-op autocommit statement, so it throws instead.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, hasDbAccessContext } from '../db';
import { remoteSessions } from '../db/schema';
import type { SessionPromptMode } from '../routes/remote/helpers';

/** Statuses a start may be published from. A terminal row is never resurrected. */
export const LIVE_START_STATUSES = ['pending', 'connecting', 'active'] as const;
export type LiveStartStatus = (typeof LIVE_START_STATUSES)[number];

/** Why a start decision was refused. */
export type StartIntentDenial =
  /** No such session (or it is invisible to the caller's RLS context). */
  | 'not_found'
  /** A terminal intent has already committed — `termination_phase <> 'none'`. */
  | 'terminal'
  /** The row left the live status set between read and commit. */
  | 'state_changed'
  /** A newer start generation committed after ours (supersession). */
  | 'superseded';

export interface DesktopStartIntent {
  ok: true;
  /** The generation this start decision committed at. */
  generation: bigint;
  /** Status of the row before the commit — callers use it for audit/UX only. */
  previousStatus: LiveStartStatus;
}

export type DesktopStartIntentResult = DesktopStartIntent | { ok: false; reason: StartIntentDenial };

/**
 * Canonical wire encoding for a generation: a plain decimal string, no
 * separators, no sign, no exponent. Every hop (command payload → agent → helper
 * IPC) uses this exact form so the value can be parsed as an int64 at the far
 * end without ever being widened to a float.
 */
export function formatDesktopGeneration(generation: bigint): string {
  return generation.toString(10);
}

/**
 * The client-visible code for a denial, so every start site names the same
 * refusal the same way — HTTP body `code`, WS `{type:'error', code}`, both.
 * Kept here rather than at the call sites because three sites drifting apart is
 * exactly how a client ends up unable to distinguish "already ended" from
 * "superseded" on one transport only.
 */
export function startIntentDenialCode(reason: StartIntentDenial): string {
  switch (reason) {
    case 'not_found': return 'SESSION_NOT_FOUND';
    case 'terminal': return 'SESSION_TERMINAL';
    case 'superseded': return 'SESSION_SUPERSEDED';
    case 'state_changed': return 'SESSION_STATE_CHANGED';
  }
}

/** The matching human-readable message for a denial. */
export function startIntentDenialMessage(reason: StartIntentDenial): string {
  switch (reason) {
    case 'not_found': return 'Session not found';
    case 'terminal': return 'This session has already been ended';
    case 'superseded': return 'This session was superseded by a newer start';
    case 'state_changed': return 'Session state changed while starting the stream';
  }
}

function requireDbAccessContext(operation: string): void {
  if (hasDbAccessContext()) return;
  throw new Error(
    `[remoteDesktopStartIntent] ${operation} requires an open db access context: ` +
      'the FOR UPDATE row lock and the generation bump must share one transaction. ' +
      'Wrap the call in withDbAccessContext/withSystemDbAccessContext.',
  );
}

interface LockedSession {
  status: string;
  terminationPhase: 'none' | 'pending' | 'confirmed';
  generation: bigint;
}

async function lockSessionForStart(sessionId: string): Promise<LockedSession | null> {
  const [row] = await db
    .select({
      status: remoteSessions.status,
      terminationPhase: remoteSessions.terminationPhase,
      generation: remoteSessions.desktopStartGeneration,
    })
    .from(remoteSessions)
    .where(eq(remoteSessions.id, sessionId))
    .limit(1)
    .for('update');

  if (!row) return null;
  return {
    status: String(row.status),
    terminationPhase: (row.terminationPhase ?? 'none') as LockedSession['terminationPhase'],
    generation: BigInt(row.generation ?? 0),
  };
}

function classifyLocked(
  locked: LockedSession | null,
  allowedStatuses: readonly string[],
): { ok: true; locked: LockedSession } | { ok: false; reason: StartIntentDenial } {
  if (!locked) return { ok: false, reason: 'not_found' };
  // Terminal intent is checked BEFORE status: a session whose teardown has
  // committed is refused with the specific reason even while its status row is
  // still nominally live (W03 sets the phase in the same transaction that makes
  // the row terminal, but a caller reading mid-flight must not see 'terminal'
  // reported as a generic state change).
  if (locked.terminationPhase !== 'none') return { ok: false, reason: 'terminal' };
  if (!allowedStatuses.includes(locked.status)) return { ok: false, reason: 'state_changed' };
  return { ok: true, locked };
}

export interface CommitDesktopStartIntentInput {
  sessionId: string;
  /** The one-off command identity this exact start is bound to. */
  startCommandId: string;
  promptMode: SessionPromptMode;
  /** The viewer's SDP offer. */
  offer: string;
}

/**
 * Commit a WebRTC desktop start decision (the two `/offer` routes).
 *
 * Bumps the generation, binds the command identity + prompt mode, publishes the
 * offer, clears any stale answer and moves the row to `connecting`.
 */
export async function commitDesktopStartIntent(
  input: CommitDesktopStartIntentInput,
): Promise<DesktopStartIntentResult> {
  requireDbAccessContext('commitDesktopStartIntent');

  const locked = classifyLocked(await lockSessionForStart(input.sessionId), LIVE_START_STATUSES);
  if (!locked.ok) return locked;

  const previousStatus = locked.locked.status as LiveStartStatus;

  const [updated] = await db
    .update(remoteSessions)
    .set({
      webrtcOffer: input.offer,
      webrtcAnswer: null,
      desktopStartCommandId: input.startCommandId,
      desktopPromptMode: input.promptMode,
      desktopStartGeneration: sql`${remoteSessions.desktopStartGeneration} + 1`,
      status: 'connecting',
      ...(previousStatus === 'active' ? { endedAt: null } : {}),
    })
    .where(and(
      eq(remoteSessions.id, input.sessionId),
      eq(remoteSessions.terminationPhase, 'none'),
      inArray(remoteSessions.status, [...LIVE_START_STATUSES]),
    ))
    .returning({ generation: remoteSessions.desktopStartGeneration });

  if (!updated) return { ok: false, reason: 'state_changed' };

  return { ok: true, generation: BigInt(updated.generation ?? 0), previousStatus };
}

/**
 * Commit a WS-fallback desktop start decision (`desktop_stream_start`).
 *
 * The fallback transport carries no SDP offer and no per-start command
 * identity; it activates the row directly. It still takes the same row lock,
 * still refuses a terminal session, and still bumps the same generation, so the
 * endpoint fence orders it against every other start and every terminal.
 */
export async function commitDesktopStreamStartIntent(
  sessionId: string,
): Promise<DesktopStartIntentResult> {
  requireDbAccessContext('commitDesktopStreamStartIntent');

  const allowed = ['pending', 'connecting'] as const;
  const locked = classifyLocked(await lockSessionForStart(sessionId), allowed);
  if (!locked.ok) return locked;

  const [updated] = await db
    .update(remoteSessions)
    .set({
      status: 'active',
      startedAt: new Date(),
      desktopStartGeneration: sql`${remoteSessions.desktopStartGeneration} + 1`,
    })
    .where(and(
      eq(remoteSessions.id, sessionId),
      eq(remoteSessions.terminationPhase, 'none'),
      inArray(remoteSessions.status, [...allowed]),
    ))
    .returning({ generation: remoteSessions.desktopStartGeneration });

  if (!updated) return { ok: false, reason: 'state_changed' };

  return {
    ok: true,
    generation: BigInt(updated.generation ?? 0),
    previousStatus: locked.locked.status as LiveStartStatus,
  };
}

/**
 * The cheap pre-publication re-read: refuse to hand a start command to the
 * agent if anything has superseded it since the commit.
 *
 * Deliberately NOT a locking read. It narrows the window between the commit and
 * the send; it does not close it, because the authoritative refusal for a stale
 * start belongs at the endpoint (W04/W05).
 *
 * Unlike the two commit functions this does NOT require an open db access
 * context: it is a plain SELECT with no lock to lose, so it is correct (just
 * weaker) on a contextless connection. `?? 0` on the generation is defensive
 * only — the column is NOT NULL DEFAULT 0 — and it fails CLOSED if it ever
 * fired, since every committed generation is >= 1 and would read as superseded.
 */
export async function assertDesktopStartIntentCurrent(
  sessionId: string,
  generation: bigint,
): Promise<{ ok: true } | { ok: false; reason: StartIntentDenial }> {
  const [row] = await db
    .select({
      terminationPhase: remoteSessions.terminationPhase,
      generation: remoteSessions.desktopStartGeneration,
    })
    .from(remoteSessions)
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);

  if (!row) return { ok: false, reason: 'not_found' };
  if ((row.terminationPhase ?? 'none') !== 'none') return { ok: false, reason: 'terminal' };
  if (BigInt(row.generation ?? 0) !== generation) return { ok: false, reason: 'superseded' };
  return { ok: true };
}
