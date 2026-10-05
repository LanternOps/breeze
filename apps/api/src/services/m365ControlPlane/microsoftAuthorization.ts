/**
 * The only two places Breeze builds a Microsoft authorization URL for the
 * customer Graph consent flow (both profiles), identity-first (#7910):
 *
 *   1. buildMicrosoftIdentityAuthorizationUrl — v2 OIDC + PKCE sign-in at
 *      `/organizations` (initial connect) or the bound tenant (reconnect of a
 *      bound row, manifest upgrade). Proves WHO the administrator is and which
 *      tenant they belong to.
 *   2. buildMicrosoftTenantAdminConsentUrl — v1 tenant-pinned authorize with
 *      `prompt=admin_consent`, built only for the tenant phase 1 verified. The
 *      code Microsoft returns from it is discarded, never redeemed.
 *
 * The `/common/adminconsent` endpoint is deliberately gone: it stops on the
 * AADSTS50097 device-authentication interrupt and returns an unauthenticated
 * tenant hint.
 */

/** Canonical lower-case GUID only — Entra tenant/client ids as Breeze stores them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const GRAPH_RESOURCE = 'https://graph.microsoft.com';

/** `organizations` or a canonical tenant GUID. Never `common`/`consumers`/a domain. */
export type MicrosoftIdentityAuthority = 'organizations' | (string & {});

interface CallbackTarget {
  clientId: string;
  redirectUri: string;
  /** The profile's own callback pathname; the redirect URI must match it exactly. */
  expectedCallbackPath: string;
  state: string;
}

export interface IdentityAuthorizationUrlInput extends CallbackTarget {
  authority: MicrosoftIdentityAuthority;
  nonce: string;
  codeChallenge: string;
}

export interface TenantAdminConsentUrlInput extends CallbackTarget {
  tenantId: string;
}

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new Error('m365_authorization_invalid');
  return value;
}

function requireAuthority(value: string): string {
  if (value === 'organizations') return value;
  return requireUuid(value);
}

function requireOpaque(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('m365_authorization_invalid');
  }
  return value;
}

function requireRedirectUri(value: string, expectedPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('m365_authorization_invalid');
  }
  if (
    !expectedPath
    || !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== expectedPath
    || parsed.search
    || parsed.hash
  ) throw new Error('m365_authorization_invalid');
  return parsed.toString();
}

export function buildMicrosoftIdentityAuthorizationUrl(
  input: IdentityAuthorizationUrlInput,
): string {
  const authority = requireAuthority(input.authority);
  const url = new URL(`${MICROSOFT_LOGIN_ORIGIN}/${authority}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', requireUuid(input.clientId));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', requireRedirectUri(input.redirectUri, input.expectedCallbackPath));
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', requireOpaque(input.state));
  url.searchParams.set('nonce', requireOpaque(input.nonce));
  url.searchParams.set('code_challenge', requireOpaque(input.codeChallenge));
  url.searchParams.set('code_challenge_method', 'S256');
  // Stopgap: an MSP tech is usually already signed into their OWN tenant in
  // this browser, and without a prompt Microsoft silently signs them in as
  // that account — the wrong tenant gets verified. `select_account` forces the
  // account picker on initial connect AND reconnect/upgrade. It is a UX
  // nudge, not a security control: W03's confirm-tenant step is the real guard.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export function buildMicrosoftTenantAdminConsentUrl(
  input: TenantAdminConsentUrlInput,
): string {
  const tenantId = requireUuid(input.tenantId);
  const url = new URL(`${MICROSOFT_LOGIN_ORIGIN}/${tenantId}/oauth2/authorize`);
  url.searchParams.set('client_id', requireUuid(input.clientId));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', requireRedirectUri(input.redirectUri, input.expectedCallbackPath));
  url.searchParams.set('resource', GRAPH_RESOURCE);
  url.searchParams.set('prompt', 'admin_consent');
  url.searchParams.set('state', requireOpaque(input.state));
  return url.toString();
}
