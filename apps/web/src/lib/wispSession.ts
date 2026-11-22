// Wisp session binding shared by the side panel (aiStore) and the /ai/chat
// tabs (workspaceStore), #10142: both create a session under a grant with the
// same anchor, and both read a refused create the same way. Kept free of the
// step-up/WebAuthn graph (lib/wispGrant) so either store can import it
// statically; the grant read itself is a lazy import.
import { AI_SESSION_IDLE_TIMEOUT_MS, AI_SESSION_MAX_AGE_MS } from '@breeze/shared';
import type { WispState } from '../stores/aiStore';
import { fetchWithAuth } from '../stores/auth';

/**
 * Past the server's chat-session lifetime (the shared AI_SESSION_* limits; a
 * send past either is refused with 410) by the session's own timestamps. An
 * unreadable timestamp is left to the status.
 */
function pastSessionLifetime(session: { createdAt?: unknown; lastActivityAt?: unknown }, now = Date.now()): boolean {
  const ageOf = (value: unknown) => (typeof value === 'string' ? now - Date.parse(value) : Number.NaN);
  return ageOf(session.createdAt) > AI_SESSION_MAX_AGE_MS || ageOf(session.lastActivityAt) > AI_SESSION_IDLE_TIMEOUT_MS;
}

/**
 * Whether a thread's `lastSessionId` can carry the next turn (#11672: a Wisp
 * thread is one conversation, so every surface entering Wisp continues its
 * live session rather than starting a second one beside it).
 *
 * `thread.lastSessionId` is the last session stamped on the thread, not the
 * last live one: an idled-out (`expired`) or closed session would load its
 * transcript and then refuse the first send. Resume only an active session
 * that still runs under this grant and is within the server's lifetime: the
 * read reports a stale session as expired (#11430), and this check covers an
 * older API or a read that raced the expiry. A failed read is "not resumable".
 */
export async function isResumableWispSession(sessionId: string, grantId: string): Promise<boolean> {
  try {
    const res = await fetchWithAuth(`/ai/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      console.warn('[wispSession] checking the thread\'s last Wisp session failed; starting a new one', res.status);
      return false;
    }
    const body = (await res.json().catch((err: unknown) => {
      console.warn('[wispSession] the last Wisp session read was not JSON; starting a new one', err);
      return null;
    })) as { session?: { status?: unknown; wispGrantId?: unknown; createdAt?: unknown; lastActivityAt?: unknown } } | null;
    return body?.session?.status === 'active' && body.session.wispGrantId === grantId && !pastSessionLifetime(body.session);
  } catch (err) {
    console.warn('[wispSession] could not check the thread\'s last Wisp session; starting a new one', err);
    return false;
  }
}

/** Session-create refusals that mean the grant cannot carry a session at all. */
export const WISP_GRANT_UNUSABLE: ReadonlySet<string> = new Set([
  'grant_inactive',
  'grant_not_found',
  'grant_not_yours',
  'wisp_disabled',
  'entitlement_required',
]);

/**
 * The org a new session under this grant is created in: the thread's focus
 * org, else the grant's org, else none (a partner-wide grant with no focus).
 * The server refuses an explicit org that differs from the focus (409
 * focus_mismatch) rather than re-anchoring silently.
 */
export function wispSessionOrgId(w: Pick<NonNullable<WispState>, 'focusOrgId' | 'scopeOrgId'>): string | null {
  return w.focusOrgId ?? w.scopeOrgId ?? null;
}

/** A failed `GET /wisp/thread`, with the HTTP status when there was a response. */
export class WispThreadError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'WispThreadError';
  }
}

/**
 * - `grant`: an active grant to start the session under.
 * - `none`: the server answered that there is none for this caller — no
 *   grant (code no_active_grant), Wisp off (404), not entitled or no
 *   permission (4xx), or a caller who cannot hold one (not partner scope).
 * - `unknown`: no usable answer (5xx, 408/429, network, malformed body). The
 *   caller must not treat this as "no grant": a session created plain is
 *   plain for good.
 */
export type WispGrantLookup =
  | { kind: 'grant'; grant: NonNullable<WispState> }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** A definitive server "no" for this caller, as opposed to no answer. */
function isDefinitiveNo(err: unknown): boolean {
  if (!(err instanceof WispThreadError) || err.status === null) return false;
  // `fetchWispThread`'s "no grant for this scope" (200 `{ data: null }`, #10200).
  if (err.status === 200 && (err as { code?: unknown }).code === 'no_active_grant') return true;
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * The caller's active Wisp grant for the header org: the org's own grant
 * first, then a partner-wide one (the order the side panel restores a
 * session's grant in). An org-scoped (or tokenless) caller is not asked —
 * grants are partner-staff only.
 */
export async function findActiveWispGrant(orgId: string | null): Promise<WispGrantLookup> {
  try {
    const { getJwtClaims } = await import('./authScope');
    if (getJwtClaims().scope !== 'partner') return { kind: 'none' };
    const { fetchWispThread } = await import('./wispGrant');
    for (const scope of orgId ? [orgId, null] : [null]) {
      try {
        const state = await fetchWispThread(scope);
        if (state.status === 'active') return { kind: 'grant', grant: state };
      } catch (err) {
        if (isDefinitiveNo(err)) continue;
        console.warn('[wispSession] the Wisp grant lookup got no usable answer', { scope, err });
        return { kind: 'unknown' };
      }
    }
    return { kind: 'none' };
  } catch (err) {
    console.warn('[wispSession] could not look up the active Wisp grant', err);
    return { kind: 'unknown' };
  }
}
