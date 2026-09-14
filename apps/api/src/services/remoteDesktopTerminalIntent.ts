/**
 * SEC-038 W03 (#5534) — the one way to declare a remote session terminal.
 *
 * W02 (`remoteDesktopStartIntent.ts`) made every desktop START a serialized
 * decision that bumps `desktop_start_generation`. That only orders starts
 * against starts. To order a start against a TERMINAL decision the terminal
 * side has to bump the same generation — and there were seven independent
 * terminal writers, none of which did (REST End, the org/user/device teardown,
 * the stale-row sweeps, the lease revocation, the WS-fallback finalization, the
 * pre-start replacement sweep, and the agent's own denied/failed/disconnected
 * results). Every one of them now writes through `terminalIntentSet`, which:
 *
 *   1. bumps `desktop_start_generation` (the same counter every start bumps),
 *   2. records that value as `terminal_generation`,
 *   3. sets `termination_phase` — `'pending'` when the server decided and the
 *      endpoint has not yet acknowledged, `'confirmed'` when the endpoint's own
 *      stop proof is already in hand (or the row has no endpoint to ask),
 *   4. carries whatever terminal columns the writer already wrote (status,
 *      endedAt, errorMessage, …).
 *
 * The stop the server then sends carries `terminalGeneration` in BOTH the
 * command id and the payload (`buildStopDesktopCommand`), so the agent's fence
 * (W04) can tombstone against it and the API can bind the agent's stop result
 * back to this exact terminal decision: `confirmDesktopTerminalIntent` moves
 * `pending → confirmed` only when the result's identity names the generation
 * the row is waiting on. A legacy `desk-stop-<sessionId>` result carries no
 * generation and confirms nothing — fail closed.
 *
 * The table-driven proof that EVERY writer goes through here is
 * `src/__tests__/integration/remoteDesktopTerminalIntent.integration.test.ts`.
 * Adding a terminal writer without adding it there is the failure this wave
 * exists to prevent; the test header says how to register one.
 *
 * Generations never pass through a JavaScript `Number`: `bigint` in storage
 * and here, canonical decimal string on the wire (`formatDesktopGeneration`).
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { remoteSessions } from '../db/schema';
import { formatDesktopGeneration } from './remoteDesktopStartIntent';

/** Statuses a terminal decision may leave the row in. */
export const TERMINAL_REMOTE_SESSION_STATUSES = ['disconnected', 'failed', 'denied'] as const;
export type TerminalRemoteSessionStatus = (typeof TERMINAL_REMOTE_SESSION_STATUSES)[number];

/** The live statuses a terminal decision may be taken from. Mirrors W02's `LIVE_START_STATUSES`. */
const LIVE_STATUSES = ['pending', 'connecting', 'active'] as const;

/**
 * Who is asserting the terminal fact.
 *
 * - `'pending'` — the SERVER decided (operator End, teardown, sweep, lease
 *   revocation). A `stop_desktop` still has to reach the endpoint; the phase
 *   moves to `'confirmed'` when its result lands. Only a desktop row can be
 *   pending — every other session type has no endpoint acknowledgement flow,
 *   so its terminal decision is final the moment it commits and the set clause
 *   writes `'confirmed'` for it directly.
 * - `'confirmed'` — the ENDPOINT is the source of the fact (agent reported
 *   failed / denied / peer-disconnected, or a `desktop_stream_stop` proof is
 *   already held). Nothing is left to acknowledge.
 */
export type TerminalPhaseSource = 'pending' | 'confirmed';

/** The terminal columns a writer supplies; everything else is the contract's. */
export interface TerminalIntentWrite {
  status: TerminalRemoteSessionStatus;
  endedAt: Date;
  errorMessage?: string | SQL | null;
  durationSeconds?: number;
  bytesTransferred?: bigint | null;
  recordingUrl?: string | null;
}

/**
 * The set clause every terminal writer must use. Returns a plain object so it
 * drops straight into `db.update(remoteSessions).set(...)` for single-row and
 * bulk (predicate-scoped) writers alike — the bulk writers are why this is a
 * clause and not a function that owns the UPDATE.
 */
export function terminalIntentSet<W extends TerminalIntentWrite>(
  write: W,
  phase: TerminalPhaseSource,
): W & {
  desktopStartGeneration: SQL;
  terminalGeneration: SQL;
  terminationPhase: SQL | 'confirmed';
} {
  if (!(TERMINAL_REMOTE_SESSION_STATUSES as readonly string[]).includes(write.status)) {
    throw new Error(
      `[remoteDesktopTerminalIntent] terminalIntentSet requires a terminal status, got '${String(write.status)}'`,
    );
  }
  // Both expressions read the OLD column value inside one UPDATE, so they land
  // on the same number: the generation this terminal decision committed at.
  const bumped = sql`${remoteSessions.desktopStartGeneration} + 1`;
  return {
    ...write,
    desktopStartGeneration: bumped,
    terminalGeneration: bumped,
    terminationPhase: phase === 'confirmed'
      ? 'confirmed'
      : sql`CASE WHEN ${remoteSessions.type} = 'desktop' THEN 'pending' ELSE 'confirmed' END`,
  };
}

/**
 * The row shape every terminal commit returns — what a teardown needs to send
 * the stop, plus the identity an audit of the decision needs.
 */
export interface TerminalSessionRow {
  id: string;
  type: string;
  deviceId: string;
  orgId: string;
  userId: string;
  status: string;
  promptMode: string | null;
  terminalGeneration: bigint;
  terminationPhase: 'pending' | 'confirmed';
}

/**
 * The RETURNING projection bulk writers should use so their rows satisfy
 * `TerminalSessionRow`. A function, not a module-level constant: many mocked
 * suites stub `../db/schema` without `remoteSessions`, and a load-time column
 * access would break every file that transitively imports this module.
 */
export function terminalSessionReturning() {
  return {
    id: remoteSessions.id,
    type: remoteSessions.type,
    deviceId: remoteSessions.deviceId,
    orgId: remoteSessions.orgId,
    userId: remoteSessions.userId,
    status: remoteSessions.status,
    promptMode: remoteSessions.desktopPromptMode,
    terminalGeneration: remoteSessions.terminalGeneration,
    terminationPhase: remoteSessions.terminationPhase,
  } as const;
}

/** Normalize a RETURNING row (driver may hand the bigint back as a string). */
export function toTerminalSessionRow(row: {
  id: string;
  type: string;
  deviceId: string;
  orgId?: string;
  userId?: string;
  status: string;
  promptMode?: string | null;
  terminalGeneration: bigint | string | number | null;
  terminationPhase: string | null;
}): TerminalSessionRow {
  if (row.terminalGeneration == null) {
    // Unreachable through this module: the set clause always writes it. Fail
    // loudly rather than send a stop with no generation to fence against.
    throw new Error(`[remoteDesktopTerminalIntent] terminal row ${row.id} has no terminal generation`);
  }
  return {
    id: row.id,
    type: String(row.type),
    deviceId: row.deviceId,
    orgId: row.orgId ?? '',
    userId: row.userId ?? '',
    status: String(row.status),
    promptMode: row.promptMode ?? null,
    terminalGeneration: BigInt(row.terminalGeneration),
    terminationPhase: (row.terminationPhase ?? 'confirmed') as TerminalSessionRow['terminationPhase'],
  };
}

export type CommitDesktopTerminalIntentResult =
  | { ok: true; terminalGeneration: bigint; row: TerminalSessionRow }
  /** No live row matched — already terminal, or gone. */
  | { ok: false; reason: 'not_live' };

export interface CommitDesktopTerminalIntentInput {
  sessionId: string;
  write: TerminalIntentWrite;
  phase: TerminalPhaseSource;
  /** Extra predicates ANDed onto the live-status guard (device ownership, exact start identity, …). */
  where?: SQL[];
}

/**
 * Commit a terminal decision for ONE session. A single guarded UPDATE: the
 * generation bump reads the old value inside the same statement, so no row
 * lock is needed for atomicity and the caller's transaction shape (request
 * context or system context) is irrelevant to correctness — only one terminal
 * commit can ever match the live-status guard.
 */
export async function commitDesktopTerminalIntent(
  input: CommitDesktopTerminalIntentInput,
): Promise<CommitDesktopTerminalIntentResult> {
  const [updated] = await db
    .update(remoteSessions)
    .set(terminalIntentSet(input.write, input.phase))
    .where(and(
      eq(remoteSessions.id, input.sessionId),
      inArray(remoteSessions.status, [...LIVE_STATUSES]),
      ...(input.where ?? []),
    ))
    .returning(terminalSessionReturning());

  if (!updated) return { ok: false, reason: 'not_live' };
  const row = toTerminalSessionRow(updated);
  return { ok: true, terminalGeneration: row.terminalGeneration, row };
}

// ---------------------------------------------------------------------------
// Wire: the stop command and its identity
// ---------------------------------------------------------------------------

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
// Canonical decimal only: no leading zero, no sign, no exponent. Anything else
// is not something this module ever emitted and must not confirm a row.
const DESKTOP_STOP_COMMAND_RE = new RegExp(`^desk-stop-(${UUID_RE})-([1-9][0-9]*)$`, 'i');

export interface StopDesktopCommand {
  id: string;
  type: 'stop_desktop';
  payload: { sessionId: string; terminalGeneration: string };
}

/**
 * The one stop command shape. The generation is bound into the id so the
 * agent's `command_result` (which echoes only the id) can be tied back to this
 * exact terminal decision, and into the payload so W04's fence can read it
 * without parsing the id. Two writers racing on the same session cannot
 * produce different ids: only one terminal commit matches the live guard, so
 * both see the same generation and the agent's id-based dedup still collapses
 * them.
 */
export function buildStopDesktopCommand(sessionId: string, terminalGeneration: bigint): StopDesktopCommand {
  const generation = formatDesktopGeneration(terminalGeneration);
  return {
    id: `desk-stop-${sessionId}-${generation}`,
    type: 'stop_desktop',
    payload: { sessionId, terminalGeneration: generation },
  };
}

/**
 * Parse a stop identity back out of a command id. Returns null for anything
 * that is not exactly `desk-stop-<uuid>-<canonical decimal>` — including the
 * pre-W03 `desk-stop-<uuid>` form, which carries no generation and therefore
 * cannot confirm a terminal intent.
 */
export function parseDesktopStopCommandId(
  commandId: string,
): { sessionId: string; terminalGeneration: bigint } | null {
  const match = DESKTOP_STOP_COMMAND_RE.exec(commandId);
  if (!match?.[1] || !match[2]) return null;
  return { sessionId: match[1], terminalGeneration: BigInt(match[2]) };
}

// ---------------------------------------------------------------------------
// pending → confirmed
// ---------------------------------------------------------------------------

/**
 * The endpoint acknowledged the stop: move the phase to `'confirmed'`, but
 * only if the result names the generation the row is waiting on AND the
 * reporting agent owns the device. A stale or foreign result — an older
 * generation, a different device, a row that is not pending — matches nothing
 * and the intent stands.
 */
export async function confirmDesktopTerminalIntent(input: {
  sessionId: string;
  deviceId: string;
  terminalGeneration: bigint;
}): Promise<'confirmed' | 'no_match'> {
  const [updated] = await db
    .update(remoteSessions)
    .set({ terminationPhase: 'confirmed' })
    .where(and(
      eq(remoteSessions.id, input.sessionId),
      eq(remoteSessions.deviceId, input.deviceId),
      eq(remoteSessions.terminationPhase, 'pending'),
      eq(remoteSessions.terminalGeneration, input.terminalGeneration),
    ))
    .returning({ id: remoteSessions.id });
  return updated ? 'confirmed' : 'no_match';
}
