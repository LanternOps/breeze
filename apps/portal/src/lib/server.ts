import {
  buildServerForwardHeaders,
  portalApi,
  type ApiRequestConfig,
  type BrandingConfig
} from './api';
export { PORTAL_SESSION_COOKIE_NAME, hasPortalSessionCookie } from './session';

export const defaultBranding: BrandingConfig = {
  name: 'Customer Portal',
  supportEmail: 'support@example.com'
};

export function buildServerApiConfig(request: Request): ApiRequestConfig {
  return {
    headers: buildServerForwardHeaders(request),
    redirectOnUnauthorized: false
  };
}

export async function loadPortalBranding(request: Request): Promise<BrandingConfig> {
  const response = await portalApi.getBranding(buildServerApiConfig(request));
  return { ...defaultBranding, ...(response.data ?? {}) };
}
