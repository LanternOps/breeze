/**
 * CORS allowlist for the digest-addressed extension web-module route.
 *
 * An extension client panel runs in an add-in pane served from a DIFFERENT
 * origin than this API (e.g. https://localhost:3004 in dev) and must
 * `import()` an extension's web-bundle module from
 * `/api/v1/extensions/assets/...` (routes/extensionsWeb.ts). The global CORS
 * layer (services/corsOrigins.ts) is scoped to the app's own web/viewer
 * origins, so panel origins get their own, narrower grant:
 *
 *  - `EXTENSION_CLIENT_PANEL_ORIGINS` — comma-separated exact origins. Unset
 *    or empty means NO cross-origin access (default-deny).
 *  - No wildcard, ever: `*` (or any entry containing `*`) is dropped at
 *    parse time, and the resolver only ever echoes an exact allowlisted
 *    origin. Entries must be BARE origins — anything with a path, query,
 *    or that fails URL parsing is dropped, fail-closed.
 *  - The grant covers ONLY the web-module route: `resolve(origin, path)`
 *    returns null for every path outside EXTENSION_WEB_MODULE_PATH_PREFIX,
 *    so an allowlisted panel origin gains nothing anywhere else on the API.
 *
 * `withExtensionPanelOrigins` composes this with the base resolver in the
 * exact shape hono/cors expects, and is shared by index.ts and the tests so
 * the wiring under test is the wiring that ships.
 */

/** The one path subtree panel origins may reach cross-origin. */
export const EXTENSION_WEB_MODULE_PATH_PREFIX = '/api/v1/extensions/assets/';

export function parseExtensionClientPanelOrigins(raw: string | undefined): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    // NO wildcard origin — a `*` grant on an authenticated, credentialed API
    // route is never acceptable; drop the entry rather than boot with it.
    if (value.includes('*')) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    // Must be a bare origin (scheme://host[:port]) — an entry that carries a
    // path/query/fragment (or an opaque-origin scheme, which serializes to
    // "null") is a config mistake, and fail-closed beats a partial match.
    if (parsed.origin === 'null' || parsed.origin !== value) continue;
    allowed.add(parsed.origin);
  }
  return allowed;
}

export interface ExtensionPanelOriginResolverOptions {
  /** Raw comma-separated allowlist; defaults to EXTENSION_CLIENT_PANEL_ORIGINS. */
  configuredOriginsRaw?: string;
}

/**
 * Resolver over (origin, request path): the exact origin when it is
 * allowlisted AND the path is under the web-module route; null otherwise.
 */
export function createExtensionPanelOriginResolver(
  options: ExtensionPanelOriginResolverOptions = {},
): (origin: string, path: string) => string | null {
  const allowed = parseExtensionClientPanelOrigins(
    options.configuredOriginsRaw ?? process.env.EXTENSION_CLIENT_PANEL_ORIGINS,
  );
  return (origin: string, path: string): string | null => {
    if (!origin) return null;
    if (!path.startsWith(EXTENSION_WEB_MODULE_PATH_PREFIX)) return null;
    return allowed.has(origin) ? origin : null;
  };
}

/**
 * Compose the app-wide CORS origin resolver with the panel-origin resolver in
 * the `origin(origin, c)` callback shape hono/cors calls. The base answer
 * wins; the panel resolver can only ADD the module-route grant, never mask or
 * widen anything the base already decided.
 */
export function withExtensionPanelOrigins(
  base: (origin?: string) => string | null,
  panel: (origin: string, path: string) => string | null,
): (origin: string, c: { req: { path: string } }) => string | null {
  return (origin, c) => base(origin) ?? panel(origin, c.req.path);
}
