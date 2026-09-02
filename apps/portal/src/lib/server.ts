import {
  buildServerForwardHeaders,
  portalApi,
  type ApiRequestConfig,
  type BrandingConfig
} from './api';
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

export async function loadPortalBranding(request: Request): Promise<BrandingConfig> {
  const response = await portalApi.getBranding(buildServerApiConfig(request));
  // 404 is the documented shared-domain case (no custom domain → no row);
  // anything else is a real failure that should leave a trace.
  if (!response.data && response.statusCode !== 404) {
    console.error('[portal] branding load failed', { statusCode: response.statusCode, error: response.error });
  }
  return { ...defaultBranding, ...(response.data ?? {}) };
}
