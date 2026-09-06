import {
  buildServerForwardHeaders,
  portalApi,
  type ApiRequestConfig,
  type BrandingConfig
} from './api';
import { hasPortalSessionCookie } from './session';
export { PORTAL_SESSION_COOKIE_NAME, hasPortalSessionCookie } from './session';

export const defaultBranding: BrandingConfig = {
  name: 'Customer Portal'
  // No placeholder support address: the layouts only render the help block's
  // contact lines when a real one is configured. "support@example.com" used to
  // ship to every customer on a shared-domain portal.
};

export function buildServerApiConfig(request: Request): ApiRequestConfig {
  return {
    headers: buildServerForwardHeaders(request),
    redirectOnUnauthorized: false
  };
}

function brandingDomain(request: Request): string {
  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const host = forwardedHost
    || request.headers.get('host')
    || new URL(request.url).host;
  return host.split(':')[0] || '';
}

// The middleware calls loadPortalBranding on every '/' and auth-only-path
// visit for a signed-in customer to pick the flag-aware landing page — a
// hanging (not erroring) branding fetch there would otherwise block every
// such visit indefinitely. Bound only THIS function's own requests; other
// portalApi call sites built from buildServerApiConfig are unaffected.
const BRANDING_FETCH_TIMEOUT_MS = 3000;

// Session-aware branding lookup. A session cookie means we have an authenticated
// portal user, so pull their exact org's branding; otherwise fall back to the
// public-by-domain lookup keyed off the forwarded host (custom domain / shared
// domain). If an authenticated lookup 401s (expired/invalid session), retry via
// the public domain path rather than surfacing a broken page before the
// middleware's own redirect-to-login kicks in.
export async function loadPortalBranding(
  request: Request
): Promise<BrandingConfig> {
  const config: ApiRequestConfig = {
    ...buildServerApiConfig(request),
    timeoutMs: BRANDING_FETCH_TIMEOUT_MS
  };
  const domain = brandingDomain(request);
  let response = hasPortalSessionCookie(request)
    ? await portalApi.getBranding(config)
    : await portalApi.getBrandingByDomain(domain, config);

  if (!response.data && response.statusCode === 401) {
    response = await portalApi.getBrandingByDomain(domain, config);
  }

  // 404 is the documented shared-domain case (no custom domain → no row);
  // anything else is a real failure that should leave a trace.
  if (!response.data && response.statusCode !== 404) {
    console.error('[portal] branding load failed', { statusCode: response.statusCode, error: response.error });
  }
  return { ...defaultBranding, ...(response.data ?? {}) };
}
