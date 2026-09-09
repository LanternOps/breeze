import { PORTAL_ACCOUNT_DISABLED_PAGE } from './accountStatus';

/**
 * Every signed-in surface. `/quotes` and `/invoices` were missing here once, so
 * both rendered server-side for an unauthenticated visitor and only failed at
 * the API call — the 401 branch inside each page. Guarding them in the
 * middleware keeps the deep-link redirect consistent across every protected
 * route.
 *
 * Lives in lib/ (not middleware.ts) so disabledPageCoverage.test.ts can assert
 * that every signed-in page under src/pages is actually covered by a prefix —
 * a new page area that forgets its entry is the exact shape of #5320.
 */
export const PORTAL_PROTECTED_PREFIXES = [
  '/devices',
  '/tickets',
  '/assets',
  '/profile',
  '/quotes',
  '/invoices',
  '/dashboard',
  '/security',
  '/backups',
  '/reports',
  PORTAL_ACCOUNT_DISABLED_PAGE
] as const;

/** True when `pathname` (base already stripped) is a signed-in surface. */
export function isProtectedPath(pathname: string): boolean {
  return PORTAL_PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * True when the middleware must check the account status before rendering.
 *
 * #5320: the disabled-account bounce used to live only in the landing
 * computation (`/`, `/login`, `/forgot-password`) plus a hand-rolled check in
 * `quotes/index.astro`, so /security, /tickets, /dashboard, /invoices,
 * /reports, /backups, /assets, /devices and /profile all rendered the API's raw
 * "Account is not active" string inline as though it were a load failure.
 *
 * The account-disabled page itself is excluded — it is a protected page (a
 * signed-out visitor still belongs at /login), but guarding it would redirect
 * it onto itself forever. Unauthenticated surfaces are excluded implicitly by
 * not being protected paths, which also keeps a signed-out visit free of the
 * extra API round trip.
 */
export function requiresAccountStatusGuard(pathname: string): boolean {
  if (
    pathname === PORTAL_ACCOUNT_DISABLED_PAGE ||
    pathname.startsWith(`${PORTAL_ACCOUNT_DISABLED_PAGE}/`)
  ) {
    return false;
  }
  return isProtectedPath(pathname);
}
