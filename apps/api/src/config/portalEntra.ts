/**
 * The customer portal's own Entra app registration (portal registration W4,
 * plan D4/D14): "Sign in with Microsoft" and the tenant-proof run.
 *
 * Off unless BOTH `PORTAL_ENTRA_CLIENT_ID` and `PORTAL_ENTRA_CLIENT_SECRET`
 * are set. Read at call time, never at module load, so the capability
 * (`getPortalSignInCapabilities().entra`) follows the env without a restart
 * in tests and a self-hoster's change takes effect on the next boot.
 *
 * One callback URI and one consent-return URI per deployment, both fixed
 * (D4). Self-hosters register exactly these two on the app:
 *   {base}/api/v1/portal/auth/oidc/entra/callback
 *   {base}/api/v1/portal/auth/oidc/entra/consent-return
 * `base` is `PORTAL_ENTRA_CALLBACK_BASE_URL` (an origin), else the origin of
 * `PUBLIC_URL || PUBLIC_APP_URL || PUBLIC_API_URL` — the order
 * services/m365ControlPlane/runtimeConfig.ts uses for its consent callback,
 * including its local-API fallback outside production.
 *
 * The secret is env-only and never logged; nothing here echoes a value.
 */

export interface PortalEntraConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  consentReturnUrl: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The fixed redirect-URI paths (D4); the routes are mounted at exactly these. */
export const PORTAL_ENTRA_CALLBACK_PATH = '/api/v1/portal/auth/oidc/entra/callback';
export const PORTAL_ENTRA_CONSENT_RETURN_PATH = '/api/v1/portal/auth/oidc/entra/consent-return';
const LOCAL_API_ORIGIN = 'http://localhost:3001';
/** An Entra application (client) id. Normalized to lower case, as Entra emits it in `aud`. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const explicit = trimmed(source, 'PORTAL_ENTRA_CALLBACK_BASE_URL');
  if (explicit) {
    // An origin, nothing more: the API is always mounted at `/api/v1` on the
    // host the browser reaches the portal on, so a path here is a mistake that
    // would register redirect URIs no route serves.
    const parsed = parseHttpUrl(explicit);
    if (!parsed || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('PORTAL_ENTRA_CALLBACK_BASE_URL must be an origin-only HTTP(S) URL (scheme://host[:port])');
    }
    return parsed.origin;
  }

  const fallback = ['PUBLIC_URL', 'PUBLIC_APP_URL', 'PUBLIC_API_URL']
    .map((name) => trimmed(source, name))
    .find((value) => value.length > 0);
  if (!fallback) {
    if (source.NODE_ENV === 'production') {
      throw new Error(
        'PORTAL_ENTRA_CALLBACK_BASE_URL, PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required when PORTAL_ENTRA_CLIENT_ID is set',
      );
    }
    return LOCAL_API_ORIGIN;
  }
  const parsed = parseHttpUrl(fallback);
  if (!parsed) {
    throw new Error('The portal Entra callback base (PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL) must be a valid HTTP(S) URL');
  }
  return parsed.origin;
}

/**
 * The portal Entra app config, or null when it is not configured. Throws on
 * a malformed callback base or client id (validated at boot by
 * config/validate.ts, so a request never sees the throw).
 */
export function getPortalEntraConfig(source: Environment = process.env): PortalEntraConfig | null {
  const clientId = trimmed(source, 'PORTAL_ENTRA_CLIENT_ID');
  const clientSecret = trimmed(source, 'PORTAL_ENTRA_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!GUID.test(clientId)) {
    throw new Error('PORTAL_ENTRA_CLIENT_ID must be the Entra application (client) ID, a GUID');
  }

  const origin = resolveCallbackOrigin(source);
  return {
    clientId: clientId.toLowerCase(),
    clientSecret,
    callbackUrl: `${origin}${PORTAL_ENTRA_CALLBACK_PATH}`,
    consentReturnUrl: `${origin}${PORTAL_ENTRA_CONSENT_RETURN_PATH}`,
  };
}
