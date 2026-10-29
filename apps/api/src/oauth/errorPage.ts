/**
 * #9938: oidc-provider's `renderError` hook — the page a browser sees when an
 * OAuth error can't (or mustn't) go back to the client.
 *
 * oidc-provider decides WHEN to call this, and that decision is the RFC 6749
 * §4.1.2.1 one: an unknown/refused client_id or an unregistered redirect_uri is
 * never redirected to the client (lib/shared/authorization_error_handler.js);
 * a redirectable error for a valid client still goes back to it and never
 * reaches here. Browser-facing errors on the other endpoints (Accept: text/html)
 * land here too. This module only changes WHAT the browser sees.
 *
 * The library default is an unbranded "oops! something went wrong" page that
 * dumps error/error_description/state. Instead the browser is sent (303) to the
 * web app's /oauth/consent/error page, which renders in the same AuthLayout as the
 * consent screen, is translated, and explains what failed and what to do.
 *
 * Only a fixed `reason` crosses over (see @breeze/shared OAUTH_ERROR_PAGE_REASONS):
 * no client_id, state, redirect_uri or error_description. So the page reflects
 * no request input, and "unknown client" and "client not allowed" read the same
 * (both are `invalid_client`, which is all the protocol tells the caller).
 * The full error is still logged by the provider's `authorization.error` /
 * `server_error` listeners (provider.ts).
 */
import { errors } from 'oidc-provider';
import {
  OAUTH_ERROR_PAGE_PATH,
  type OauthErrorPageReason,
} from '@breeze/shared';

/** OAuth error codes whose fix, from the user's side, is "the app sent a bad request". */
const REQUEST_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_request_object',
  'invalid_request_uri',
  'invalid_scope',
  'invalid_target',
  'request_not_supported',
  'request_uri_not_supported',
  'unauthorized_client',
  'unsupported_response_mode',
  'unsupported_response_type',
]);

/**
 * Picks the page reason for an oidc-provider error. `out` is the provider's
 * error output (`error` is `server_error` for anything not exposed); `err` is
 * the thrown error. Returns null when the page has no specific copy, and the
 * page then shows its generic text.
 */
export function oauthErrorPageReason(
  out: { error?: unknown },
  err: unknown,
): OauthErrorPageReason | null {
  // SessionNotFound is an invalid_request subclass, so test it first: an
  // expired or cross-browser interaction deserves its own "start again" copy.
  if (err instanceof errors.SessionNotFound) return 'session_expired';
  const code = typeof out.error === 'string' ? out.error : '';
  if (code === 'invalid_client') return 'invalid_client';
  if (code === 'invalid_redirect_uri') return 'invalid_redirect_uri';
  if (code === 'server_error' || code === 'temporarily_unavailable') return 'server_error';
  if (REQUEST_ERROR_CODES.has(code)) return 'invalid_request';
  return null;
}

/** The web app's error page URL for `reason` (no query when there is none). */
export function buildOauthErrorPageUrl(consentUrlBase: string, reason: OauthErrorPageReason | null): string {
  const base = consentUrlBase.replace(/\/+$/, '');
  const query = reason ? `?${new URLSearchParams({ reason }).toString()}` : '';
  return `${base}${OAUTH_ERROR_PAGE_PATH}${query}`;
}

/** Minimal slice of the Koa context oidc-provider hands to `renderError`. */
interface RenderErrorContext {
  status: number;
  redirect(url: string): void;
}

/**
 * Builds the `renderError` hook. `consentUrlBase` is OAUTH_CONSENT_URL_BASE —
 * the web origin that already hosts /oauth/consent (getProvider refuses to
 * boot without it).
 */
export function createOauthErrorRenderer(consentUrlBase: string) {
  return async function renderOauthError(
    ctx: RenderErrorContext,
    out: { error?: unknown },
    err: unknown,
  ): Promise<void> {
    // 303 so a POSTed authorization request is followed with a GET.
    ctx.status = 303;
    ctx.redirect(buildOauthErrorPageUrl(consentUrlBase, oauthErrorPageReason(out, err)));
  };
}
