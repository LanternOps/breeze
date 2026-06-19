import { defineMiddleware } from 'astro:middleware';
import { hasPortalSessionCookie } from './lib/session';
import { isOutsideBase, stripBase, withBase } from './lib/basePath';
import { buildFallbackCspDirectives, resolvePortalCspHeader } from './lib/csp';

const protectedPrefixes = ['/devices', '/tickets', '/assets', '/profile'];
const authOnlyPaths = new Set(['/login', '/forgot-password']);

function isProtectedPath(pathname: string): boolean {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** True for env flags set to `1`/`true`. Mirrors apps/web/src/middleware.ts. */
function readFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** Non-CSP security headers applied to every portal response. */
function applyBaseSecurityHeaders(headers: Headers): void {
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Defense-in-depth: the portal is mounted under BASE_PATH in prod — Caddy only
  // reverse-proxies `/portal` and `/portal/*` here (handle, not handle_path), so a
  // request outside the base never legitimately reaches us (web owns the root).
  // Astro's node server is base-optional in routing and would otherwise serve pages
  // at un-based paths (e.g. /login → the portal login page); return 404 instead so
  // the portal answers strictly within its base.
  const rawPathname = context.url.pathname;
  if (isOutsideBase(rawPathname)) {
    return new Response('Not Found', { status: 404 });
  }

  // context.url.pathname includes the configured base (e.g. /portal/login); strip it
  // so the route checks below stay base-agnostic, and re-apply withBase on redirect.
  const pathname = stripBase(rawPathname);
  const hasSession = hasPortalSessionCookie(context.request);

  if (pathname === '/') {
    return context.redirect(withBase(hasSession ? '/devices' : '/login'), 302);
  }

  if (isProtectedPath(pathname) && !hasSession) {
    return context.redirect(withBase('/login'), 302);
  }

  if (hasSession && authOnlyPaths.has(pathname)) {
    return context.redirect(withBase('/devices'), 302);
  }

  const response = await next();
  const headers = new Headers(response.headers);

  // Dev hydration fix: `astro dev` does NOT emit Astro's `security.csp` hash-based
  // policy (hashing only runs at build), so the strict `script-src 'self'` fallback
  // blocks Vite/Astro's inline hydration bootstrap. That left the public quote
  // `client:load` island un-hydrated (kept its `ssr` attribute) and the Accept /
  // Decline buttons firing zero network calls. resolvePortalCspHeader drops CSP in
  // local dev (so HMR + hydration work) while keeping production strict via Astro
  // hashes. Set CSP_STRICT_DEV=1 to opt back into enforcement locally.
  const isDev = import.meta.env.DEV;
  const decision = resolvePortalCspHeader({
    existingCsp: headers.get('Content-Security-Policy'),
    isDev,
    strictDev: readFlag('CSP_STRICT_DEV'),
    fallback: buildFallbackCspDirectives({ isDev })
  });
  if (decision.action === 'delete') {
    headers.delete('Content-Security-Policy');
  } else {
    headers.set('Content-Security-Policy', decision.value);
  }
  applyBaseSecurityHeaders(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
});
