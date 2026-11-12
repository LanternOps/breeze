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
 * The secret is env-only and never logged; nothing here echoes a value. The
 * origin validation is shared with the Entra app (config/portalCallbackBase.ts).
 */

import {
  resolvePortalCallbackOrigin,
  trimmedEnv,
  type PortalCallbackEnvironment,
} from './portalCallbackBase';

export interface PortalGoogleConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

type Environment = PortalCallbackEnvironment;

/** The fixed redirect-URI path (D10); the route is mounted at exactly this. */
export const PORTAL_GOOGLE_CALLBACK_PATH = '/api/v1/portal/auth/oidc/google/callback';
/**
 * A Google OAuth client id: `<project number>-<hash>.apps.googleusercontent.com`.
 * Case-sensitive on purpose: it is compared exactly with the id token's `aud`
 * (plan D1), so an id typed in another case is refused at boot instead of
 * failing every sign-in.
 */
const GOOGLE_CLIENT_ID = /^[0-9a-z][0-9a-z-]*\.apps\.googleusercontent\.com$/;

/**
 * The portal Google client config, or null when it is not configured. Throws on
 * a malformed client id or callback base (validated at boot by
 * config/validate.ts, so a request never sees the throw).
 */
export function getPortalGoogleConfig(source: Environment = process.env): PortalGoogleConfig | null {
  const clientId = trimmedEnv(source, 'PORTAL_GOOGLE_CLIENT_ID');
  const clientSecret = trimmedEnv(source, 'PORTAL_GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!GOOGLE_CLIENT_ID.test(clientId)) {
    throw new Error('PORTAL_GOOGLE_CLIENT_ID must be a lower-case Google OAuth client ID ending in .apps.googleusercontent.com');
  }

  const origin = resolvePortalCallbackOrigin(source, {
    baseVar: 'PORTAL_GOOGLE_CALLBACK_BASE_URL',
    clientIdVar: 'PORTAL_GOOGLE_CLIENT_ID',
    label: 'Google',
  });
  return { clientId, clientSecret, callbackUrl: `${origin}${PORTAL_GOOGLE_CALLBACK_PATH}` };
}
