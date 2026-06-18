import { defineMiddleware } from 'astro:middleware';
import { hasPortalSessionCookie } from './lib/session';
import { isOutsideBase, stripBase, withBase } from './lib/basePath';

const protectedPrefixes = ['/devices', '/tickets', '/assets', '/profile'];
const authOnlyPaths = new Set(['/login', '/forgot-password']);

function isProtectedPath(pathname: string): boolean {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function resolveConnectSrcDirective(): string {
  const sources = new Set<string>(["'self'", 'https:', 'ws:', 'wss:']);
  const configuredApiUrl = process.env.PUBLIC_API_URL;

  if (configuredApiUrl) {
    try {
      const parsed = new URL(configuredApiUrl);
      sources.add(parsed.origin);
      if (parsed.protocol === 'http:') {
        sources.add(`ws://${parsed.host}`);
      } else if (parsed.protocol === 'https:') {
        sources.add(`wss://${parsed.host}`);
      }
    } catch {
      // Ignore invalid URL configuration and fall back to default policy.
    }
  }

  if (import.meta.env.DEV) {
    sources.add('http://localhost:3001');
    sources.add('ws://localhost:3001');
  }

  return `connect-src ${Array.from(sources).join(' ')}`;
}

const fallbackCspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "script-src-attr 'none'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  resolveConnectSrcDirective()
].join('; ');

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
  const existingCsp = headers.get('Content-Security-Policy');

  // Astro experimental.csp sets hash-based CSP for HTML responses.
  // Keep this strict fallback for non-HTML responses or routes without Astro rendering.
  if (!existingCsp) {
    headers.set('Content-Security-Policy', fallbackCspDirectives);
  } else {
    let patchedCsp = existingCsp;
    if (!/\bscript-src-attr\b/i.test(patchedCsp)) {
      patchedCsp = `${patchedCsp}; script-src-attr 'none'`;
    }
    if (!/\bstyle-src-attr\b/i.test(patchedCsp)) {
      patchedCsp = `${patchedCsp}; style-src-attr 'none'`;
    }
    headers.set('Content-Security-Policy', patchedCsp);
  }
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
});
