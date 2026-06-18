/**
 * Base-path helpers for the customer portal.
 *
 * The portal is served under a configurable base path (default `/portal`, set via
 * `PORTAL_BASE_PATH` at build time — see astro.config.mjs). Astro automatically
 * prefixes the base onto bundled assets and its own routing, but it does NOT
 * rewrite hand-authored `href`/redirect/`window.location` strings. Route every
 * app-internal absolute path through `withBase()` so links keep working when the
 * base changes, and use `stripBase()` when matching against the raw request
 * pathname (which includes the base).
 *
 * NB: API calls go through `buildPortalApiUrl()` in lib/api.ts and are served
 * same-origin under `/api/v1/...` (NOT under the base) — do not pass those here.
 *
 * The pure `*For(base, ...)` variants take the base explicitly and carry all the
 * logic; the default exports bind them to the build-time `BASE_PATH`. Tests use
 * the `*For` variants to cover every base (incl. root) without env stubbing.
 */

// Astro/Vite injects import.meta.env.BASE_URL from the `base` config (e.g. "/portal/").
const RAW_BASE = (import.meta.env.BASE_URL as string | undefined) ?? '/';

/** Normalize a base to: leading slash, no trailing slash. Empty string at root. */
export function normalizeBase(base: string | undefined | null): string {
  if (!base || base === '/') return '';
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.replace(/\/+$/, '');
}

/** Normalized base path the portal is served under (e.g. "/portal", or "" at root). */
export const BASE_PATH = normalizeBase(RAW_BASE);

function isExternal(path: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(path) || // scheme: http:, https:, mailto:, tel:, etc.
    path.startsWith('//') ||
    path.startsWith('#')
  );
}

/** Prefix an app-internal absolute path with an explicit base. See `withBase`. */
export function withBaseFor(base: string, path: string): string {
  if (!path) return base || '/';
  if (isExternal(path)) return path;
  // Dev-only footgun guard: API calls must go through buildPortalApiUrl, not here.
  if (import.meta.env.DEV && (path === '/api' || path.startsWith('/api/'))) {
    // eslint-disable-next-line no-console
    console.warn(`[basePath] withBase() received an API path "${path}" — use buildPortalApiUrl() instead.`);
  }
  if (!base) return path;

  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean === base || clean.startsWith(`${base}/`)) return clean;
  return `${base}${clean}`;
}

/**
 * True when a raw request pathname falls outside the given base. Always false at
 * root deploy (empty base owns everything). See `isOutsideBase`.
 */
export function isOutsideBaseFor(base: string, pathname: string): boolean {
  if (!base) return false;
  return pathname !== base && !pathname.startsWith(`${base}/`);
}

/** Strip an explicit base from a raw pathname. See `stripBase`. */
export function stripBaseFor(base: string, pathname: string): string {
  if (!base) return pathname;
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) {
    return pathname.slice(base.length) || '/';
  }
  return pathname;
}

/**
 * Prefix an app-internal absolute path (e.g. "/login") with the base path.
 * Pass-through for external URLs, mailto/tel, anchors, and already-prefixed paths.
 * Idempotent — safe to apply at call sites without checking if a path is based.
 */
export function withBase(path: string): string {
  return withBaseFor(BASE_PATH, path);
}

/**
 * Strip the base path from a raw request pathname → app-relative path.
 * "/portal/login" → "/login", "/portal" → "/", "/portal/" → "/". No-op when already de-based.
 */
export function stripBase(pathname: string): string {
  return stripBaseFor(BASE_PATH, pathname);
}

/**
 * True when a raw request pathname is outside the build-time base path. Used by the
 * middleware to 404 requests the portal should never serve (the portal is mounted
 * under BASE_PATH in prod; the root belongs to the web app). No-op at root deploy.
 */
export function isOutsideBase(pathname: string): boolean {
  return isOutsideBaseFor(BASE_PATH, pathname);
}
