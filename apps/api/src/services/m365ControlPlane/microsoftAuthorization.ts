const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CALLBACK_PATH = '/api/v1/m365/consent/callback';

interface AdminConsentUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
}

interface IdentityAuthorizationUrlInput extends AdminConsentUrlInput {
  tenantId: string;
  nonce: string;
  codeChallenge: string;
}

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new Error('m365_authorization_invalid');
  return value;
}

function requireOpaque(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('m365_authorization_invalid');
  }
  return value;
}

function requireRedirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('m365_authorization_invalid');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== CALLBACK_PATH
    || parsed.search
    || parsed.hash
  ) throw new Error('m365_authorization_invalid');
  return parsed.toString();
}

export function buildMicrosoftAdminConsentUrl(input: AdminConsentUrlInput): string {
  const url = new URL('https://login.microsoftonline.com/common/adminconsent');
  url.searchParams.set('client_id', requireUuid(input.clientId));
  url.searchParams.set('redirect_uri', requireRedirectUri(input.redirectUri));
  url.searchParams.set('state', requireOpaque(input.state));
  return url.toString();
}

export function buildMicrosoftIdentityAuthorizationUrl(
  input: IdentityAuthorizationUrlInput,
): string {
  const tenantId = requireUuid(input.tenantId);
  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', requireUuid(input.clientId));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', requireRedirectUri(input.redirectUri));
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', requireOpaque(input.state));
  url.searchParams.set('nonce', requireOpaque(input.nonce));
  url.searchParams.set('code_challenge', requireOpaque(input.codeChallenge));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
