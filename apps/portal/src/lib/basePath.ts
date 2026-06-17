/**
 * Base-path helpers for the customer portal.
 *
 * The portal is served under a configurable base path (default `/c`, set via
 * `PORTAL_BASE_PATH` at build time — see astro.config.mjs). Astro automatically
 * prefixes the base onto bundled assets and its own routing, but it does NOT
 * rewrite hand-authored `href`/redirect/`window.location` strings. Route every
 * app-internal absolute path through `withBase()` so links keep working when the
 * base changes, and use `stripBase()` when matching against the raw request
 * pathname (which includes the base).
 *
 * NB: API calls go through `buildPortalApiUrl()` in lib/api.ts and are served
 * same-origin under `/api/v1/...` (NOT under the base) — do not pass those here.
 */

// Astro/Vite injects import.meta.env.BASE_URL from the `base` config (e.g. "/c/").
const RAW_BASE = (import.meta.env.BASE_URL as string | undefined) ?? '/';

/** Normalized base path: leading slash, no trailing slash. Empty string at root. */
export const BASE_PATH = normalizeBase(RAW_BASE);

function normalizeBase(base: string): string {
  if (!base || base === '/') return '';
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.replace(/\/+$/, '');
}

function isExternal(path: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(path) || // scheme: http:, https:, mailto:, tel:, etc.
    path.startsWith('//') ||
    path.startsWith('#')
  );
}

/**
 * Prefix an app-internal absolute path (e.g. "/login") with the base path.
 * Pass-through for external URLs, mailto/tel, anchors, and already-prefixed paths.
 */
export function withBase(path: string): string {
  if (!path) return BASE_PATH || '/';
  if (isExternal(path)) return path;
  if (!BASE_PATH) return path;

  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean === BASE_PATH || clean.startsWith(`${BASE_PATH}/`)) return clean;
  return `${BASE_PATH}${clean}`;
}

/**
 * Strip the base path from a raw request pathname → app-relative path.
 * "/c/login" → "/login", "/c" → "/", "/c/" → "/". No-op when already de-based.
 */
export function stripBase(pathname: string): string {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return '/';
  if (pathname.startsWith(`${BASE_PATH}/`)) {
    return pathname.slice(BASE_PATH.length) || '/';
  }
  return pathname;
}
