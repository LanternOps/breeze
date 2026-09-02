import { stripBase, withBase } from './basePath';

export const PORTAL_SESSION_COOKIE_NAME = 'breeze_portal_session';

/** Where a signed-in customer belongs; mirrors middleware DEFAULT_LANDING. */
const DEFAULT_LANDING = '/quotes';

export function hasPortalSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return false;
  }

  const target = `${PORTAL_SESSION_COOKIE_NAME}=`;
  return cookieHeader.split(';').some((part) => part.trim().startsWith(target));
}

/**
 * Astro.cookies-compatible surface (avoids importing astro types here).
 */
interface CookieDeleter {
  delete: (name: string, opts?: { path?: string }) => void;
}

/**
 * Clear the portal session cookie before redirecting to /login after an API
 * 401. Without this, a cookie that outlives its server-side session (expired,
 * revoked, or the API restarted in dev) traps the customer in a redirect loop:
 * the page's 401 sends them to /login, the middleware sees a cookie present
 * and bounces them straight back, and the page 401s again — ERR_TOO_MANY_REDIRECTS
 * instead of a login form. The API sets the cookie host-scoped at path=/
 * (PORTAL_SESSION_COOKIE_PATH in apps/api routes/portal/schemas.ts), so that
 * is the one path to delete at.
 */
export function clearPortalSessionCookie(cookies: CookieDeleter): void {
  cookies.delete(PORTAL_SESSION_COOKIE_NAME, { path: '/' });
}

/** The slice of Astro's global a page hands us to bounce a dead session. */
interface RedirectContext {
  cookies: CookieDeleter;
  url: URL;
  redirect: (path: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
}

/**
 * The one way a page answers an API 401: clear the stale cookie, then send the
 * customer to /login with `?next=` pointing back here — the emailed-link case
 * (invoice, proposal) is exactly the one where the cookie has usually expired,
 * and the middleware's own deep-link redirect only fires when the cookie is
 * ABSENT. Every protected page must call this rather than hand-rolling the
 * redirect; sessionClearCoverage.test.ts enforces it.
 */
export function redirectToLoginAfter401(ctx: RedirectContext): Response {
  clearPortalSessionCookie(ctx.cookies);
  const pathname = stripBase(ctx.url.pathname);
  const target = `${pathname}${ctx.url.search}`;
  const home = pathname === '/' || pathname === DEFAULT_LANDING;
  return ctx.redirect(withBase(home ? '/login' : `/login?next=${encodeURIComponent(target)}`), 302);
}

