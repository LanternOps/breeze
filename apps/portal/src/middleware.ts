import { defineMiddleware } from 'astro:middleware';
import { randomBytes } from 'node:crypto';
import { hasPortalSessionCookie } from './lib/session';
import { isOutsideBase, stripBase, withBase } from './lib/basePath';
import { buildFallbackCspDirectives, resolvePortalCspHeader } from './lib/csp';
import { prefixDevAssetUrls, shouldPrefixDevAssetUrls } from './lib/devAssetBase';
import { loadPortalBranding } from './lib/server';
import { portalLandingPath } from './lib/landing';

// Every signed-in surface. `/quotes` and `/invoices` were missing here, so both
// rendered server-side for an unauthenticated visitor and only failed at the API
// call — the 401 branch inside each page. Guarding them in the middleware keeps
// the deep-link redirect (below) consistent across every protected route.
const protectedPrefixes = [
  '/devices',
  '/tickets',
  '/assets',
  '/profile',
  '/quotes',
  '/invoices',
  '/dashboard',
  '/security',
  '/backups',
  '/reports'
];
const authOnlyPaths = new Set(['/login', '/forgot-password']);

/** Build `/login?next=<path>` so an emailed deep link survives the auth wall. */
function loginWithNext(pathname: string, search: string): string {
  const target = `${pathname}${search}`;
  if (pathname === '/') return withBase('/login');
  return withBase(`/login?next=${encodeURIComponent(target)}`);
}

/** Where a signed-in customer belongs, per their org's visibility flags. They
 *  come to read a proposal or pay a bill; `/dashboard` only leads when the
 *  org has explicitly turned it on (fail-closed, #4562). */
async function authenticatedLanding(request: Request): Promise<'/dashboard' | '/quotes'> {
  return portalLandingPath(await loadPortalBranding(request));
}

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

  // Per-request nonce for the single runtime-themed `<style>` element the
  // proposal/invoice documents emit (partner accent colour). Generated before
  // `next()` so pages can read it off locals while rendering.
  context.locals.cspNonce = randomBytes(16).toString('base64');

  if (pathname === '/') {
    if (!hasSession) {
      return context.redirect(withBase('/login'), 302);
    }
    return context.redirect(
      withBase(await authenticatedLanding(context.request)),
      302
    );
  }

  if (isProtectedPath(pathname) && !hasSession) {
    return context.redirect(loginWithNext(pathname, context.url.search), 302);
  }

  if (hasSession && authOnlyPaths.has(pathname)) {
    return context.redirect(
      withBase(await authenticatedLanding(context.request)),
      302
    );
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
    fallback: buildFallbackCspDirectives({ isDev }),
    styleNonce: context.locals.cspNonce
  });
  if (decision.action === 'delete') {
    headers.delete('Content-Security-Policy');
  } else {
    headers.set('Content-Security-Policy', decision.value);
  }
  applyBaseSecurityHeaders(headers);

  // Token-bearing public document pages (/quote/<token>, /invoice/<token> and
  // its checkout-return trampoline): the URL itself is the capability, so it
  // must never land in referrer headers, shared caches, or search indexes.
  // strict-origin-when-cross-origin (the base policy) still sends the full
  // token url on same-origin navigation — no-referrer does not.
  if (pathname.startsWith('/quote/') || pathname.startsWith('/invoice/')) {
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    headers.set('Cache-Control', 'no-store');
  }

  // #3906 — dev only: Astro hardcodes a few dev-server URLs straight into the
  // rendered HTML (`/@vite/client`, the island's `component-url` / `renderer-url` /
  // `before-hydration-url`, the `/src/styles/*` stylesheet). Vite's `base` — which
  // the `breeze:portal-dev-base` plugin in astro.config.mjs sets — covers the rest
  // of the module graph but never reaches those, and they are precisely the entry
  // points that start hydration. Behind the worktree stack's path-routed Caddy an
  // unprefixed entry point resolves against the *web* app, so the island stays
  // dead while the SSR'd markup still looks right. Buffering the body costs dev
  // streaming only; a production build ships base-prefixed bundled assets and
  // never enters this branch. shouldPrefixDevAssetUrls carries the conditions
  // (and the reason each one matters) so they stay unit-testable.
  let body: BodyInit | null = response.body;
  if (
    shouldPrefixDevAssetUrls({
      isDev,
      hasBody: response.body !== null,
      contentType: headers.get('Content-Type')
    })
  ) {
    body = prefixDevAssetUrls(await response.text());
    // The rewritten body is longer than the original; a stale Content-Length
    // would truncate it.
    headers.delete('Content-Length');
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
});
