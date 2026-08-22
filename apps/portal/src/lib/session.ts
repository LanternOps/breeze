export const PORTAL_SESSION_COOKIE_NAME = 'breeze_portal_session';

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
 * instead of a login form. The cookie is host-scoped at path=/ (set by the
 * API), so delete against both the base path and root.
 */
export function clearPortalSessionCookie(cookies: CookieDeleter): void {
  cookies.delete(PORTAL_SESSION_COOKIE_NAME, { path: '/' });
}
