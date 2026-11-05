// Wisp session binding shared by the side panel (aiStore) and the /ai/chat
// tabs (workspaceStore), #10142: both create a session under a grant with the
// same anchor, and both read a refused create the same way. Kept free of the
// step-up/WebAuthn graph (lib/wispGrant) so either store can import it
// statically; the grant read itself is a lazy import.
import type { WispState } from '../stores/aiStore';

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
