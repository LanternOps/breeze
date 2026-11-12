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
 * The secret is env-only and never logged; nothing here echoes a value. The
 * origin validation is shared with the Google client (config/portalCallbackBase.ts).
 */

import {
  resolvePortalCallbackOrigin,
  trimmedEnv,
  type PortalCallbackEnvironment,
} from './portalCallbackBase';

export interface PortalEntraConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  consentReturnUrl: string;
}

type Environment = PortalCallbackEnvironment;

/** The fixed redirect-URI paths (D4); the routes are mounted at exactly these. */
export const PORTAL_ENTRA_CALLBACK_PATH = '/api/v1/portal/auth/oidc/entra/callback';
export const PORTAL_ENTRA_CONSENT_RETURN_PATH = '/api/v1/portal/auth/oidc/entra/consent-return';
/** An Entra application (client) id. Normalized to lower case, as Entra emits it in `aud`. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The portal Entra app config, or null when it is not configured. Throws on
 * a malformed callback base or client id (validated at boot by
 * config/validate.ts, so a request never sees the throw).
 */
export function getPortalEntraConfig(source: Environment = process.env): PortalEntraConfig | null {
  const clientId = trimmedEnv(source, 'PORTAL_ENTRA_CLIENT_ID');
  const clientSecret = trimmedEnv(source, 'PORTAL_ENTRA_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!GUID.test(clientId)) {
    throw new Error('PORTAL_ENTRA_CLIENT_ID must be the Entra application (client) ID, a GUID');
  }

  const origin = resolvePortalCallbackOrigin(source, {
    baseVar: 'PORTAL_ENTRA_CALLBACK_BASE_URL',
    clientIdVar: 'PORTAL_ENTRA_CLIENT_ID',
    label: 'Entra',
  });
  return {
    clientId: clientId.toLowerCase(),
    clientSecret,
    callbackUrl: `${origin}${PORTAL_ENTRA_CALLBACK_PATH}`,
    consentReturnUrl: `${origin}${PORTAL_ENTRA_CONSENT_RETURN_PATH}`,
  };
}
