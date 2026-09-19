import { withBase } from './basePath';

/**
 * The `code` the API's portal auth gate answers with when a portal user's
 * account has been disabled/suspended (apps/api/src/routes/portal/auth.ts,
 * `PORTAL_ACCOUNT_INACTIVE_CODE` — kept in sync by hand, same convention as
 * the visibility-gate codes in lib/visibilityGate.ts).
 *
 * This is deliberately NOT one of `PORTAL_DISABLED_CODES`: those mean "the MSP
 * switched a PAGE off" and bounce to `PORTAL_UNGATED_HOME`; this means "the
 * MSP disabled the whole ACCOUNT" and must land on its own page instead —
 * bouncing to `/quotes` would just 403 there too (sweep 2026-09-08 G5-6).
 */
export const PORTAL_ACCOUNT_INACTIVE_CODE = 'PORTAL_ACCOUNT_INACTIVE';

/** Where a disabled portal user lands instead of the generic outage copy. */
export const PORTAL_ACCOUNT_DISABLED_PAGE = '/account-disabled';

/** The shape of a portalApi response this module reads. */
interface PortalResponseState {
  statusCode?: number;
  code?: string;
}

/** True when a portalApi response is the account-disabled 403, not a generic
 *  load failure or an unrelated (page-visibility) gate. */
export function isAccountDisabledResponse(response: PortalResponseState): boolean {
  return response.statusCode === 403 && response.code === PORTAL_ACCOUNT_INACTIVE_CODE;
}

/** The slice of Astro's global a page hands us to bounce a disabled account. */
interface RedirectContext {
  redirect: (path: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
}

/**
 * The one way a page answers the account-disabled 403: send the customer to
 * the dedicated "access has been disabled" page (with a working Sign out)
 * rather than rendering its own "we couldn't load this" copy.
 */
export function redirectToAccountDisabled(ctx: RedirectContext): Response {
  return ctx.redirect(withBase(PORTAL_ACCOUNT_DISABLED_PAGE), 302);
}
