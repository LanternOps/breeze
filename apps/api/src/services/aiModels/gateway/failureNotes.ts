/**
 * The last gateway failure seen for an AI session, so the chat turn that owns
 * it can say WHY it failed (#7794). The Agent SDK CLI retries a failed
 * upstream call on its own and, when it gives up, reports a generic error (or
 * the turn times out). The gateway's own reason would otherwise never reach the
 * technician.
 *
 * In-memory and per process. The gateway is a loopback server inside the
 * same API process as the session that spawned the CLI child. Notes are
 * client-safe text only (no URL, host or credential), bounded in count, and
 * expire.
 */
export const GATEWAY_FAILURE_NOTE_TTL_MS = 15 * 60_000;
export const GATEWAY_FAILURE_NOTE_MAX_ENTRIES = 1_000;

/** A failure the turn's settlement records by name, rather than only showing its text (#10577). */
export type GatewayFailureCode = 'context_window_exceeded';
export interface GatewayFailure { message: string; code: GatewayFailureCode | null }

const notes = new Map<string, GatewayFailure & { at: number }>();

export function noteGatewayFailure(aiSessionId: string | null, message: string, code: GatewayFailureCode | null = null): void {
  if (!aiSessionId) return;
  notes.delete(aiSessionId); // re-insert so Map order stays oldest-first
  notes.set(aiSessionId, { message, code, at: Date.now() });
  while (notes.size > GATEWAY_FAILURE_NOTE_MAX_ENTRIES) {
    const oldest = notes.keys().next().value;
    if (oldest === undefined) break;
    notes.delete(oldest);
  }
}

/** The session's pending failure, removed as it is read; null when none or expired. */
export function takeGatewayFailure(aiSessionId: string | null): GatewayFailure | null {
  if (!aiSessionId) return null;
  const note = notes.get(aiSessionId);
  if (!note) return null;
  notes.delete(aiSessionId);
  return Date.now() - note.at > GATEWAY_FAILURE_NOTE_TTL_MS ? null : { message: note.message, code: note.code };
}

/** The session's pending note text, removed as it is read; null when none or expired. */
export function takeGatewayFailureNote(aiSessionId: string | null): string | null {
  return takeGatewayFailure(aiSessionId)?.message ?? null;
}

export function __resetGatewayFailureNotesForTests(): void {
  notes.clear();
}
