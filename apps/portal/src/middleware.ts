import { defineMiddleware } from 'astro:middleware';
import { hasPortalSessionCookie } from './lib/session';

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
  const pathname = context.url.pathname;
  const hasSession = hasPortalSessionCookie(context.request);

  if (pathname === '/') {
    return context.redirect(hasSession ? '/devices' : '/login', 302);
  }

  if (isProtectedPath(pathname) && !hasSession) {
    return context.redirect('/login', 302);
  }

  if (hasSession && authOnlyPaths.has(pathname)) {
    return context.redirect('/devices', 302);
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
