/**
 * The callback origin shared by the customer portal's own OAuth clients
 * (portal registration W4 Entra, config/portalEntra.ts; W7 Google,
 * config/portalGoogle.ts). One copy of the validation, because each provider
 * registers the URIs built on it as its exact redirect URIs.
 *
 * The origin is `<baseVar>` (an origin, nothing more), else the origin of
 * `PUBLIC_URL || PUBLIC_APP_URL || PUBLIC_API_URL` — the order
 * services/m365ControlPlane/runtimeConfig.ts uses for its consent callback,
 * including its local-API fallback outside production. Blank reads as unset.
 * No value is ever echoed in an error.
 */

export type PortalCallbackEnvironment = Readonly<Record<string, string | undefined>>;

export interface PortalCallbackOriginOptions {
  /** The provider's own base override, e.g. `PORTAL_ENTRA_CALLBACK_BASE_URL`. */
  baseVar: string;
  /** The client id variable named in the "required in production" error, e.g. `PORTAL_ENTRA_CLIENT_ID`. */
  clientIdVar: string;
  /** The provider as it reads in an error sentence, e.g. `Entra`. */
  label: string;
}

const LOCAL_API_ORIGIN = 'http://localhost:3001';

/** `source[name]`, trimmed; '' when unset. */
export function trimmedEnv(source: PortalCallbackEnvironment, name: string): string {
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

/** The origin the provider's fixed callback paths are built on. Throws on a malformed value. */
export function resolvePortalCallbackOrigin(source: PortalCallbackEnvironment, opts: PortalCallbackOriginOptions): string {
  const explicit = trimmedEnv(source, opts.baseVar);
  if (explicit) {
    // An origin, nothing more: the API is always mounted at `/api/v1` on the
    // host the browser reaches the portal on, so a path here is a mistake that
    // would register redirect URIs no route serves.
    const parsed = parseHttpUrl(explicit);
    if (!parsed || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`${opts.baseVar} must be an origin-only HTTP(S) URL (scheme://host[:port])`);
    }
    return parsed.origin;
  }

  const fallback = ['PUBLIC_URL', 'PUBLIC_APP_URL', 'PUBLIC_API_URL']
    .map((name) => trimmedEnv(source, name))
    .find((value) => value.length > 0);
  if (!fallback) {
    if (source.NODE_ENV === 'production') {
      throw new Error(
        `${opts.baseVar}, PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required when ${opts.clientIdVar} is set`,
      );
    }
    return LOCAL_API_ORIGIN;
  }
  const parsed = parseHttpUrl(fallback);
  if (!parsed) {
    throw new Error(`The portal ${opts.label} callback base (PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL) must be a valid HTTP(S) URL`);
  }
  return parsed.origin;
}
