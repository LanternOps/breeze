import { useJwtClaims } from '../../lib/authScope';
import { useAuthStore } from '../../stores/auth';

/**
 * Who may use the ticket import (#8313; spec 2026-10-19 §5.7, §5.11): a
 * partner-scope, partner-wide admin, the web mirror of the API's
 * `requireScope('partner')` plus `canManagePartnerWidePolicies`. A system
 * session is refused by the routes (`callerPartner`), so it is refused here
 * too. UX only: the server enforces every route.
 *
 * `canManagePartnerWide` must be an explicit `true` (from `/users/me`): a
 * session from before the field hides the button until the next refresh
 * rather than offering a page the server may refuse.
 */
export type TicketImportAccess = 'unknown' | 'allowed' | 'denied';

export function useTicketImportAccess(): TicketImportAccess {
  const claims = useJwtClaims();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide);
  if (claims.status === 'unresolved') return 'unknown';
  if (claims.claims.scope !== 'partner' || !claims.claims.partnerId) return 'denied';
  return canManagePartnerWide === true ? 'allowed' : 'denied';
}
