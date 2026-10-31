// #9938: copy selection for /oauth/consent/error — the page the OAuth authorization
// server sends a browser to when an error must not go back to the client
// (apps/api/src/oauth/errorPage.ts). The page gets one `reason` from a fixed
// list; anything else (missing, unknown, hand-edited) shows the generic copy.
import { isOauthErrorPageReason, type OauthErrorPageReason } from '@breeze/shared';

export type OauthErrorView = OauthErrorPageReason | 'generic';

export function resolveOauthErrorView(raw: string | null): OauthErrorView {
  return isOauthErrorPageReason(raw) ? raw : 'generic';
}

const COPY: Record<OauthErrorView, { headingKey: string; bodyKey: string }> = {
  invalid_client: {
    headingKey: 'oauthErrorPage.invalidClient.heading',
    bodyKey: 'oauthErrorPage.invalidClient.body',
  },
  invalid_redirect_uri: {
    headingKey: 'oauthErrorPage.invalidRedirectUri.heading',
    bodyKey: 'oauthErrorPage.invalidRedirectUri.body',
  },
  session_expired: {
    headingKey: 'oauthErrorPage.sessionExpired.heading',
    bodyKey: 'oauthErrorPage.sessionExpired.body',
  },
  invalid_request: {
    headingKey: 'oauthErrorPage.invalidRequest.heading',
    bodyKey: 'oauthErrorPage.invalidRequest.body',
  },
  server_error: {
    headingKey: 'oauthErrorPage.serverError.heading',
    bodyKey: 'oauthErrorPage.serverError.body',
  },
  generic: {
    headingKey: 'oauthErrorPage.generic.heading',
    bodyKey: 'oauthErrorPage.generic.body',
  },
};

/** pages.json keys (tServer) for the view's heading and body. */
export function oauthErrorCopy(view: OauthErrorView): { headingKey: string; bodyKey: string } {
  return COPY[view];
}
