// #9938: the reasons the OAuth authorization server can send a browser to the
// web app's OAuth error page with. Shared by the API (which picks one from the
// oidc-provider error) and the web page (which maps each to fixed copy), so a
// reason the page has no text for cannot be sent. Leaf module, no imports.
//
// The page receives ONLY one of these values — never the client_id, state,
// redirect_uri or error_description — so it cannot be used to reflect request
// input, and it says nothing about a client beyond what the OAuth error code
// itself already tells the caller.

// Under /oauth/consent/ on purpose: everything else under /oauth/* goes to the
// API, and /oauth/consent/* is the one subtree every documented proxy
// (docker/Caddyfile.prod, the guided-setup nginx config, the Cloudflare tunnel
// docs) already sends to web — so self-hosters need no proxy change.
export const OAUTH_ERROR_PAGE_PATH = '/oauth/consent/error';

export const OAUTH_ERROR_PAGE_REASONS = [
  'invalid_client',
  'invalid_redirect_uri',
  'session_expired',
  'invalid_request',
  'server_error',
] as const;

export type OauthErrorPageReason = (typeof OAUTH_ERROR_PAGE_REASONS)[number];

export function isOauthErrorPageReason(value: unknown): value is OauthErrorPageReason {
  return typeof value === 'string' && (OAUTH_ERROR_PAGE_REASONS as readonly string[]).includes(value);
}
