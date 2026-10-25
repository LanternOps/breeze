// Wisp session binding shared by the side panel (aiStore) and the /wisp/chat
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

/**
 * The caller's active Wisp grant for the header org: the org's own grant
 * first, then a partner-wide one (the order the side panel restores a
 * session's grant in). Null when there is none, and whenever Wisp cannot
 * apply: an org-scoped (or tokenless) caller is not asked — grants are
 * partner-staff only — and a server that has Wisp off, an unentitled partner
 * or a failed read all answer "no grant", which leaves a plain chat.
 */
export async function findActiveWispGrant(orgId: string | null): Promise<NonNullable<WispState> | null> {
  try {
    const { getJwtClaims } = await import('./authScope');
    if (getJwtClaims().scope !== 'partner') return null;
    const { fetchWispThread } = await import('./wispGrant');
    for (const scope of orgId ? [orgId, null] : [null]) {
      const state = await fetchWispThread(scope).catch(() => null);
      if (state?.status === 'active') return state;
    }
    return null;
  } catch (err) {
    console.warn('[wispSession] could not look up the active Wisp grant; starting a plain chat', err);
    return null;
  }
}
