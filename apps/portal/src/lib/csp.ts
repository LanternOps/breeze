/**
 * Content-Security-Policy helpers for the customer portal.
 *
 * Kept free of `astro:*` virtual-module imports so they can be unit-tested under
 * vitest without aliasing (mirrors apps/web/src/lib/csp.ts). The middleware wires
 * these into the request lifecycle.
 */

/** Build the `connect-src` directive, widening for the configured API origin (+ dev). */
export function resolveConnectSrcDirective(options?: { isDev?: boolean }): string {
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

  if (options?.isDev) {
    sources.add('http://localhost:3001');
    sources.add('ws://localhost:3001');
  }

  return `connect-src ${Array.from(sources).join(' ')}`;
}

/** Strict self-only fallback policy (no inline). Used for non-HTML/CSP-less responses. */
export function buildFallbackCspDirectives(options?: { isDev?: boolean }): string {
  return [
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
    resolveConnectSrcDirective({ isDev: options?.isDev })
  ].join('; ');
}

/**
 * Decide the CSP header for a portal response. Pure + exported for unit testing.
 *
 *  - `delete`: drop the header entirely (local dev, so Vite/Astro inline hydration
 *    scripts run — see the dead-island bug). Returned only when `isDev && !strictDev`.
 *  - `set` with `value`: the strict policy. In a production build Astro's
 *    `security.csp` puts its per-page script hashes on the existing header — we
 *    preserve those and append the granular *-src-attr lockdowns (so the inline
 *    hydration bootstrap stays allowed by hash). When Astro emitted no header
 *    (non-HTML responses, or routes without a rendered CSP) we fall back to strict
 *    self-only. We NEVER widen to 'unsafe-inline' here.
 */
export function resolvePortalCspHeader(opts: {
  existingCsp: string | null;
  isDev: boolean;
  strictDev: boolean;
  fallback: string;
}): { action: 'delete' } | { action: 'set'; value: string } {
  if (opts.isDev && !opts.strictDev) {
    return { action: 'delete' };
  }
  if (!opts.existingCsp) {
    return { action: 'set', value: opts.fallback };
  }
  let patchedCsp = opts.existingCsp;
  if (!/\bscript-src-attr\b/i.test(patchedCsp)) {
    patchedCsp = `${patchedCsp}; script-src-attr 'none'`;
  }
  if (!/\bstyle-src-attr\b/i.test(patchedCsp)) {
    patchedCsp = `${patchedCsp}; style-src-attr 'none'`;
  }
  return { action: 'set', value: patchedCsp };
}
