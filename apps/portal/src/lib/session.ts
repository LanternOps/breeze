export const PORTAL_SESSION_COOKIE_NAME = 'breeze_portal_session';

export function hasPortalSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return false;
  }

  const target = `${PORTAL_SESSION_COOKIE_NAME}=`;
  return cookieHeader.split(';').some((part) => part.trim().startsWith(target));
}
