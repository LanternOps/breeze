import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const GLOBAL_ADMIN_ROLE_ID = '62e90394-69f5-4237-9190-012177145e10';
export const PRIVILEGED_ROLE_ADMIN_ROLE_ID = 'e8611ab8-c189-46e8-94e1-60213ab1f814';

export interface MicrosoftAdminIdTokenClaims {
  tid: string;
  oid: string;
  sub: string;
  wids: string[];
}

export class MicrosoftIdentityVerificationError extends Error {
  override readonly name = 'MicrosoftIdentityVerificationError';
  constructor(
    message: 'Invalid Microsoft tenant' | 'Microsoft identity verification failed' | 'Microsoft tenant mismatch',
  ) {
    super(message);
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface MicrosoftIdentityDependencies {
  fetch?: FetchLike;
  verificationKey?: CryptoKey;
}

const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const MICROSOFT_JWKS_URL = `${MICROSOFT_LOGIN_ORIGIN}/common/discovery/v2.0/keys`;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ALGORITHMS = ['RS256'] as const;
const ACCEPTED_ADMIN_ROLES = new Set([
  GLOBAL_ADMIN_ROLE_ID,
  PRIVILEGED_ROLE_ADMIN_ROLE_ID,
]);

let cachedMicrosoftJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function normalizeGuid(value: unknown): string | null {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

function requireTenantHint(tenantHint: string): string {
  const tenant = normalizeGuid(tenantHint);
  if (!tenant) throw new MicrosoftIdentityVerificationError('Invalid Microsoft tenant');
  return tenant;
}

function getMicrosoftJwks(): ReturnType<typeof createRemoteJWKSet> {
  cachedMicrosoftJwks ??= createRemoteJWKSet(new URL(MICROSOFT_JWKS_URL), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  return cachedMicrosoftJwks;
}

export function buildMicrosoftAuthorizationUrl(input: {
  tenantHint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const tenant = requireTenantHint(input.tenantHint);
  const url = new URL(`/${tenant}/oauth2/v2.0/authorize`, MICROSOFT_LOGIN_ORIGIN);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeMicrosoftAuthorizationCode(input: {
  tenantHint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}, dependencies: Pick<MicrosoftIdentityDependencies, 'fetch'> = {}): Promise<{ idToken: string }> {
  const tenant = requireTenantHint(input.tenantHint);
  const tokenUrl = new URL(`/${tenant}/oauth2/v2.0/token`, MICROSOFT_LOGIN_ORIGIN);
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
  });

  try {
    const response = await (dependencies.fetch ?? globalThis.fetch)(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
    });
    if (!response.ok) throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');

    const tokenResponse: unknown = await response.json();
    const idToken = (
      typeof tokenResponse === 'object' && tokenResponse !== null
        ? (tokenResponse as Record<string, unknown>).id_token
        : undefined
    );
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
    }
    return { idToken };
  } catch {
    throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
  }
}

export async function verifyMicrosoftAdminIdToken(
  idToken: string,
  expected: { tenantHint: string; clientId: string; nonce: string },
  dependencies: Pick<MicrosoftIdentityDependencies, 'verificationKey'> = {},
): Promise<MicrosoftAdminIdTokenClaims> {
  const expectedTenant = requireTenantHint(expected.tenantHint);

  let payload: JWTPayload & Record<string, unknown>;
  try {
    const verifyOptions = {
      audience: expected.clientId,
      algorithms: [...ALLOWED_ALGORITHMS],
      requiredClaims: ['exp', 'aud', 'iss', 'sub'],
    };
    const verified = dependencies.verificationKey
      ? await jwtVerify(idToken, dependencies.verificationKey, verifyOptions)
      : await jwtVerify(idToken, getMicrosoftJwks(), verifyOptions);
    payload = verified.payload;
  } catch {
    throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
  }

  const tid = normalizeGuid(payload.tid);
  if (!tid) throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
  if (tid !== expectedTenant) throw new MicrosoftIdentityVerificationError('Microsoft tenant mismatch');

  const oid = normalizeGuid(payload.oid);
  const expectedIssuer = `${MICROSOFT_LOGIN_ORIGIN}/${tid}/v2.0`;
  const wids = Array.isArray(payload.wids) && payload.wids.every((wid) => typeof wid === 'string')
    ? payload.wids
    : null;
  if (
    !oid
    || payload.iss !== expectedIssuer
    || payload.nonce !== expected.nonce
    || typeof payload.sub !== 'string'
    || payload.sub.length === 0
    || !wids
    || !hasMailboxConsentAdminRole(wids)
  ) {
    throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
  }

  return {
    tid,
    oid,
    sub: payload.sub,
    wids: [...wids],
  };
}

export function hasMailboxConsentAdminRole(wids: readonly string[]): boolean {
  return wids.some((wid) => ACCEPTED_ADMIN_ROLES.has(wid.toLowerCase()));
}
