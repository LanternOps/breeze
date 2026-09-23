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

/**
 * Every identity failure surfaces to callers as one sanitized error. This
 * names which check failed, server-side only, so an operator can tell a
 * nonce mismatch from a bad signature from a token-endpoint 400. It never
 * carries token, code, or response-body content.
 */
function logIdentityCheckFailure(check: string, extra: { status?: number } = {}): void {
  console.warn('[ticketMailbox] Microsoft identity check failed', { check, ...extra });
}

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
  // Directory.Read.All (delegated) lets checkMailboxConsentAdminRoleViaGraph fall back
  // to a live Graph directory-role lookup when the `wids` ID token claim is
  // absent. Must also be added as a Delegated permission on the app
  // registration and admin-consented, or the live check will 403.
  url.searchParams.set('scope', 'openid profile Directory.Read.All');
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
}, dependencies: Pick<MicrosoftIdentityDependencies, 'fetch'> = {}): Promise<{ idToken: string; accessToken: string | null }> {
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
    if (!response.ok) {
      logIdentityCheckFailure('token_exchange_http', { status: response.status });
      throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
    }

    const tokenResponse: unknown = await response.json();
    const record = typeof tokenResponse === 'object' && tokenResponse !== null
      ? (tokenResponse as Record<string, unknown>)
      : undefined;
    const idToken = record?.id_token;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      logIdentityCheckFailure('token_exchange_missing_id_token');
      throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
    }
    // Optional: only used for the live directory-role fallback below. Its
    // absence must never fail the exchange — the wids claim path still works
    // without it, and probeMailbox/Graph mail calls use the app-only token
    // from getMailboxToken(), not this delegated one.
    const accessToken = typeof record?.access_token === 'string' && record.access_token.length > 0
      ? record.access_token
      : null;
    return { idToken, accessToken };
  } catch (error) {
    if (error instanceof MicrosoftIdentityVerificationError) throw error;
    logIdentityCheckFailure('token_exchange_request');
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
    logIdentityCheckFailure('id_token_jwt');
    throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
  }

  const tid = normalizeGuid(payload.tid);
  if (!tid) {
    logIdentityCheckFailure('id_token_tid');
    throw new MicrosoftIdentityVerificationError('Microsoft identity verification failed');
  }
  if (tid !== expectedTenant) {
    logIdentityCheckFailure('id_token_tenant_mismatch');
    throw new MicrosoftIdentityVerificationError('Microsoft tenant mismatch');
  }

  const oid = normalizeGuid(payload.oid);
  const expectedIssuer = `${MICROSOFT_LOGIN_ORIGIN}/${tid}/v2.0`;
  // `wids` is intentionally NOT required here. Some tenants do not populate
  // it in the ID token even with optionalClaims.idToken correctly configured
  // (observed against a from-scratch app registration, verified with
  // Microsoft's own jwt.ms token inspector — see the linked GitHub issue).
  // Admin-role verification for mailbox consent now happens one level up in
  // hasMailboxConsentAdminRole / checkMailboxConsentAdminRoleViaGraph, which
  // treats wids as a fast path and falls back to a live Graph role lookup.
  const wids = Array.isArray(payload.wids) && payload.wids.every((wid) => typeof wid === 'string')
    ? payload.wids
    : [];
  const failedCheck = !oid ? 'oid'
    : payload.iss !== expectedIssuer ? 'issuer'
      : payload.nonce !== expected.nonce ? 'nonce'
        : typeof payload.sub !== 'string' || payload.sub.length === 0 ? 'sub'
          : null;
  if (failedCheck || !oid || typeof payload.sub !== 'string') {
    logIdentityCheckFailure(failedCheck ?? 'claims');
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

export type GraphAdminRoleCheckFailure =
  | 'no_access_token'
  | 'graph_request_failed'
  | 'graph_http_error'
  | 'graph_malformed_response'
  | 'principal_mismatch'
  | 'tenant_mismatch'
  | 'no_accepted_role'
  | 'role_page_limit';

export type GraphAdminRoleCheckResult =
  | { ok: true }
  | { ok: false; reason: GraphAdminRoleCheckFailure; status?: number };

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_ME_URL = `${GRAPH_ORIGIN}/v1.0/me?$select=id`;
const GRAPH_ORGANIZATION_URL = `${GRAPH_ORIGIN}/v1.0/organization?$select=id`;
const GRAPH_DIRECTORY_ROLES_URL =
  `${GRAPH_ORIGIN}/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole?$select=roleTemplateId`;
const MAX_DIRECTORY_ROLE_PAGES = 5;

class GraphCheckFailure extends Error {
  constructor(readonly reason: GraphAdminRoleCheckFailure, readonly status?: number) {
    super(reason);
  }
}

/**
 * Fallback for tenants where the `wids` ID token claim is not populated even
 * with optionalClaims.idToken correctly configured on the app registration.
 * Reads the signed-in user's directory role membership directly from Graph
 * using the delegated access token from the same authorization-code
 * exchange. Requires the Directory.Read.All delegated permission to be
 * granted (admin-consented) on the app registration.
 *
 * The result is bound to the verified ID token: Graph must report the token's
 * principal as `expected.oid` and its home tenant as `expected.tid` before any
 * role is considered, so a delegated token for a different user or tenant can
 * never satisfy the check. Every failure (missing token, HTTP error, network
 * error, malformed body, binding mismatch, no accepted role) resolves to
 * `ok: false` with a reason for server-side diagnostics — never to success,
 * and never by throwing. The reason carries no token or response content.
 */
export async function checkMailboxConsentAdminRoleViaGraph(
  accessToken: string | null,
  expected: { tid: string; oid: string },
  dependencies: Pick<MicrosoftIdentityDependencies, 'fetch'> = {},
): Promise<GraphAdminRoleCheckResult> {
  if (!accessToken) return { ok: false, reason: 'no_access_token' };
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;

  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: 'error',
      });
    } catch {
      throw new GraphCheckFailure('graph_request_failed');
    }
    if (!response.ok) throw new GraphCheckFailure('graph_http_error', response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GraphCheckFailure('graph_malformed_response');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new GraphCheckFailure('graph_malformed_response');
    }
    return body as Record<string, unknown>;
  };

  try {
    const me = await getJson(GRAPH_ME_URL);
    if (normalizeGuid(me.id) !== normalizeGuid(expected.oid)) {
      return { ok: false, reason: 'principal_mismatch' };
    }

    const organization = await getJson(GRAPH_ORGANIZATION_URL);
    const tenants = Array.isArray(organization.value) ? organization.value : [];
    const tenantIds = tenants.map((org) => (
      typeof org === 'object' && org !== null ? normalizeGuid((org as Record<string, unknown>).id) : null
    ));
    if (tenantIds.length !== 1 || tenantIds[0] === null || tenantIds[0] !== normalizeGuid(expected.tid)) {
      return { ok: false, reason: 'tenant_mismatch' };
    }

    let url: string | null = GRAPH_DIRECTORY_ROLES_URL;
    for (let page = 0; url; page += 1) {
      // Fail closed, but distinguishably: a truncated scan is not a verdict.
      if (page >= MAX_DIRECTORY_ROLE_PAGES) return { ok: false, reason: 'role_page_limit' };
      const body = await getJson(url);
      if (!Array.isArray(body.value)) return { ok: false, reason: 'graph_malformed_response' };
      const roleTemplateIds = body.value
        .map((role) => (typeof role === 'object' && role !== null
          ? (role as Record<string, unknown>).roleTemplateId
          : undefined))
        .filter((id): id is string => typeof id === 'string');
      if (hasMailboxConsentAdminRole(roleTemplateIds)) return { ok: true };

      const nextLink = body['@odata.nextLink'];
      if (nextLink === undefined) {
        url = null;
      } else if (typeof nextLink === 'string' && nextLink.startsWith(`${GRAPH_ORIGIN}/`)) {
        url = nextLink;
      } else {
        return { ok: false, reason: 'graph_malformed_response' };
      }
    }
    return { ok: false, reason: 'no_accepted_role' };
  } catch (error) {
    if (error instanceof GraphCheckFailure) {
      return error.status === undefined
        ? { ok: false, reason: error.reason }
        : { ok: false, reason: error.reason, status: error.status };
    }
    return { ok: false, reason: 'graph_request_failed' };
  }
}
