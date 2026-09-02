/**
 * Dev-only: base-prefix the raw dev-server module URLs Astro writes into the page.
 *
 * `astro dev` deliberately keeps Vite base-agnostic — it strips the configured
 * `base` off every incoming request in its own front-of-stack middleware and then
 * emits Vite's module URLs from the server root. `astro.config.mjs` puts Vite's
 * `base` back (see the `breeze:portal-dev-base` plugin there), which covers the
 * whole *module graph* — import analysis, pre-bundled deps, HMR client,
 * react-refresh. It does NOT cover the handful of URLs Astro itself hardcodes
 * into the rendered HTML:
 *
 *   <script type="module" src="/@vite/client">
 *   <script type="module" src="/src/styles/globals.css">
 *   <astro-island component-url="/src/components/portal/PublicQuoteView.tsx"
 *                 renderer-url="/@fs/…" before-hydration-url="/@id/…">
 *
 * Those are the *entry points* of the island module graph, so leaving them
 * unprefixed leaves every island dead: behind the worktree/dev stack's Caddy the
 * portal is routed by path (`/portal` and `/portal/*`), so an unprefixed
 * `/src/components/portal/PublicQuoteView.tsx` fell through to the web app and
 * 404'd — the page SSR'd correctly and then silently never hydrated (#3906).
 *
 * Prefixing is a pure string rewrite over the dev server's own URL namespaces,
 * none of which can collide with a portal route or an API path. It runs only when
 * `import.meta.env.DEV` is set (see src/middleware.ts); a production build serves
 * bundled assets that Astro already prefixes with the base.
 */

import { BASE_PATH } from './basePath';

/**
 * URL namespaces the Astro/Vite dev server owns. Every one of these is served by
 * the dev server's own middleware — none is a portal route, and API calls
 * (`/api/v1/...`) are deliberately absent so they keep going to the API origin.
 *
 * `@` is deliberately the bare prefix rather than an enumeration of the four
 * namespaces we actually observed (`/@fs/`, `/@id/`, `/@vite/`,
 * `/@react-refresh`). Vite reserves the whole `/@…` space for dev-server
 * internals and adds to it across versions, and a namespace missing from a
 * hand-maintained list would fail exactly the way #3906 did: silently, with the
 * page still SSR'ing correctly and only a console 404 nobody reads. Matching the
 * reserved prefix means a namespace we have never seen still routes to the
 * portal. No portal route begins with `/@`.
 */
export const DEV_ASSET_NAMESPACES = ['@', 'src/', 'node_modules/'] as const;

/**
 * Matches a root-relative dev-server URL sitting in an HTML attribute value —
 * `="/@fs/…`, `="/src/…` and friends. Anchoring on `="` (or `='`) keeps the
 * rewrite inside attribute values instead of touching page text (and leaves
 * Vite's `data-vite-dev-id`, which holds an absolute *filesystem* path rather
 * than a URL, correctly alone). An already-prefixed URL (`="/portal/@fs/…`)
 * does not match, so the rewrite is idempotent.
 *
 * Built from DEV_ASSET_NAMESPACES so the list above stays the single source of
 * truth — a namespace added there is picked up here automatically.
 */
const DEV_ASSET_URL_RE = new RegExp(
  `(=["'])\\/(${DEV_ASSET_NAMESPACES.map((ns) => ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  'g'
);

/**
 * Prefix the dev server's module URLs in `html` with an explicit base.
 * Pass-through at root deploy (empty base owns everything already).
 */
export function prefixDevAssetUrlsFor(base: string, html: string): string {
  if (!base) return html;
  return html.replace(DEV_ASSET_URL_RE, (_match, attr: string, namespace: string) =>
    `${attr}${base}/${namespace}`
  );
}

/** Prefix the dev server's module URLs with the build-time base path. */
export function prefixDevAssetUrls(html: string): string {
  return prefixDevAssetUrlsFor(BASE_PATH, html);
}

/** True when a response body is HTML we should rewrite. */
export function isHtmlContentType(contentType: string | null): boolean {
  return !!contentType && contentType.split(';', 1)[0].trim().toLowerCase() === 'text/html';
}

/**
 * Whether a response should get the rewrite, with the base passed explicitly.
 *
 * `hasBody` is load-bearing rather than an optimisation: a null-body status
 * (204/304/…) has nothing to rewrite, and swapping its null body for the empty
 * string the rewrite would return makes the `Response` constructor throw.
 */
export function shouldPrefixDevAssetUrlsFor(
  base: string,
  input: { isDev: boolean; hasBody: boolean; contentType: string | null }
): boolean {
  return !!base && input.isDev && input.hasBody && isHtmlContentType(input.contentType);
}

/** Whether a response should get the rewrite, bound to the build-time base path. */
export function shouldPrefixDevAssetUrls(input: {
  isDev: boolean;
  hasBody: boolean;
  contentType: string | null;
}): boolean {
  return shouldPrefixDevAssetUrlsFor(BASE_PATH, input);
}
