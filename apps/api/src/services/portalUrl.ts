/**
 * Customer-portal base-URL resolution, shared by every service/route that
 * embeds a portal link in customer-facing output (quote accept emails, invoice
 * emails, Stripe checkout redirect URLs, portal invite/reset links).
 *
 * `PUBLIC_PORTAL_URL` is expected to already carry the portal base path
 * (e.g. `https://us.2breeze.app/portal`). The app-origin fallbacks
 * (`PUBLIC_APP_URL` / `DASHBOARD_URL`) are the bare MSP app root, so the
 * portal base path (`PORTAL_BASE_PATH`, default `/portal`) is appended to
 * them here — before this helper, the fallbacks emitted dead links missing
 * `/portal` whenever `PUBLIC_PORTAL_URL` was unset (the common prod config).
 *
 * Hardening (carried over from the original quoteLifecycle implementation):
 * a candidate that is empty, an empty-authority triple-slash form
 * (`https:///portal`), or otherwise parses to an empty host (e.g. a scheme-only
 * value like `localhost:4321`, which `new URL` reads as scheme `localhost:`
 * with an empty hostname rather than throwing — a bare `https://` instead
 * throws and is caught by the branch below) must NEVER silently produce an
 * empty-host URL in a customer-facing email. We walk the configured chain
 * and, if none yields a usable host, throw loudly so callers' best-effort
 * email swallows record the failure rather than mailing a dead link.
 */

/** Portal base path appended to app-origin fallbacks. Normalized to a leading
 * slash and no trailing slash; an explicit `/` (portal served at the root)
 * normalizes to '' so nothing is appended. */
function portalBasePath(): string {
  const raw = process.env.PORTAL_BASE_PATH?.trim();
  if (raw === undefined || raw === '') return '/portal';
  const stripped = raw.replace(/\/+$/, '');
  if (stripped === '') return ''; // PORTAL_BASE_PATH="/" — portal at app root
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

export function portalBase(): string {
  const basePath = portalBasePath();
  // `appendPortalPath` marks app-origin candidates that need the portal base
  // path appended; PUBLIC_PORTAL_URL and the localhost fallback already carry it.
  const candidates: Array<{ value: string | undefined; appendPortalPath: boolean }> = [
    { value: process.env.PUBLIC_PORTAL_URL, appendPortalPath: false },
    { value: process.env.PUBLIC_APP_URL, appendPortalPath: true },
    { value: process.env.DASHBOARD_URL, appendPortalPath: true },
    { value: 'http://localhost:4321/portal', appendPortalPath: false },
  ];

  for (const candidate of candidates) {
    const trimmed = candidate.value?.trim();
    if (!trimmed) continue;
    // Reject the empty-authority triple-slash form before parsing: `https:///portal`
    // (a templating accident where the host var didn't interpolate) has an empty
    // authority, but `new URL('https:///portal').hostname` reinterprets the first
    // path segment (`portal`) as the host — so the parsed-hostname guard below would
    // wrongly pass and we'd emit a dead `https:///portal/quote/...` link. Treat any
    // value whose authority component (between `://` and the next `/`, `?`, `#`, or
    // end) is empty as malformed and skip it.
    if (/^[a-z][a-z0-9+.-]*:\/\/(?=[/?#]|$)/i.test(trimmed)) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      // Not a parseable absolute URL (bare `https://`, host-only string, etc.) — skip.
      continue;
    }
    // A misconfigured value that parses successfully but yields no host (e.g. a
    // scheme-only string like `localhost:4321`, parsed as scheme `localhost:`
    // with an empty hostname — a bare `https://` instead throws and is caught
    // above) must be rejected too, so we never emit an empty-host URL.
    if (!parsed.hostname) continue;
    const base = trimmed.replace(/\/+$/, '');
    // Tolerate an app-origin value that was already configured with the portal
    // path (e.g. PUBLIC_APP_URL=https://host/portal) — don't double-append.
    if (!candidate.appendPortalPath || basePath === '' || base.endsWith(basePath)) return base;
    return base + basePath;
  }

  // The localhost fallback above always has a host, so this is unreachable in
  // practice — but if every configured value were malformed we fail loudly
  // rather than hand back an empty-host link.
  throw new Error(
    '[portalUrl] Cannot build a customer portal URL: PUBLIC_PORTAL_URL / PUBLIC_APP_URL / DASHBOARD_URL are unset or malformed (no host).',
  );
}
