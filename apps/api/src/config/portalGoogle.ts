/**
 * The customer portal's own Google OAuth web client (portal registration W7,
 * plan D10/D11): "Sign in with Google".
 *
 * Off unless BOTH `PORTAL_GOOGLE_CLIENT_ID` and `PORTAL_GOOGLE_CLIENT_SECRET`
 * are set. Read at call time, never at module load, so the capability
 * (`getPortalSignInCapabilities().google`) follows the env without a restart
 * in tests and a self-hoster's change takes effect on the next boot.
 *
 * One fixed redirect URI per deployment (D10). Self-hosters register exactly:
 *   {base}/api/v1/portal/auth/oidc/google/callback
 * `base` is `PORTAL_GOOGLE_CALLBACK_BASE_URL` (an origin), else the origin of
 * `PUBLIC_URL || PUBLIC_APP_URL || PUBLIC_API_URL` — the W4 Entra chain
 * (config/portalEntra.ts), including its local-API fallback outside production.
 *
 * The secret is env-only and never logged; nothing here echoes a value.
 */

export interface PortalGoogleConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The fixed redirect-URI path (D10); the route is mounted at exactly this. */
export const PORTAL_GOOGLE_CALLBACK_PATH = '/api/v1/portal/auth/oidc/google/callback';
const LOCAL_API_ORIGIN = 'http://localhost:3001';
/** A Google OAuth client id: `<project number>-<hash>.apps.googleusercontent.com`. Compared exactly with `aud`. */
const GOOGLE_CLIENT_ID = /^[0-9a-z][0-9a-z-]*\.apps\.googleusercontent\.com$/i;

function trimmed(source: Environment, name: string): string {
  return source[name]?.trim() ?? '';
}

function parseHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed;
}

function resolveCallbackOrigin(source: Environment): string {
  const explicit = trimmed(source, 'PORTAL_GOOGLE_CALLBACK_BASE_URL');
  if (explicit) {
    // An origin, nothing more: the API is always mounted at `/api/v1`, so a path
    // here would register a redirect URI no route serves.
    const parsed = parseHttpUrl(explicit);
    if (!parsed || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('PORTAL_GOOGLE_CALLBACK_BASE_URL must be an origin-only HTTP(S) URL (scheme://host[:port])');
    }
    return parsed.origin;
  }

  const fallback = ['PUBLIC_URL', 'PUBLIC_APP_URL', 'PUBLIC_API_URL']
    .map((name) => trimmed(source, name))
    .find((value) => value.length > 0);
  if (!fallback) {
    if (source.NODE_ENV === 'production') {
      throw new Error(
        'PORTAL_GOOGLE_CALLBACK_BASE_URL, PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required when PORTAL_GOOGLE_CLIENT_ID is set',
      );
    }
    return LOCAL_API_ORIGIN;
  }
  const parsed = parseHttpUrl(fallback);
  if (!parsed) {
    throw new Error('The portal Google callback base (PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL) must be a valid HTTP(S) URL');
  }
  return parsed.origin;
}

/**
 * The portal Google client config, or null when it is not configured. Throws on
 * a malformed client id or callback base (validated at boot by
 * config/validate.ts, so a request never sees the throw).
 */
export function getPortalGoogleConfig(source: Environment = process.env): PortalGoogleConfig | null {
  const clientId = trimmed(source, 'PORTAL_GOOGLE_CLIENT_ID');
  const clientSecret = trimmed(source, 'PORTAL_GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!GOOGLE_CLIENT_ID.test(clientId)) {
    throw new Error('PORTAL_GOOGLE_CLIENT_ID must be a Google OAuth client ID ending in .apps.googleusercontent.com');
  }

  const origin = resolveCallbackOrigin(source);
  return { clientId, clientSecret, callbackUrl: `${origin}${PORTAL_GOOGLE_CALLBACK_PATH}` };
}
