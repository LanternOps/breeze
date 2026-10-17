/**
 * Shared tool-source credential header builder — Tool Catalog W2 (#5217).
 *
 * The ONE place a tool source's decrypted credential becomes request headers,
 * used by both transports (the MCP client and the OpenAPI client/spec fetch)
 * so they pin credentials to `credential_origin` identically. Drift between
 * two copies of this logic would mean a credential leaving for an origin it
 * was never pinned to.
 *
 * Origin pinning happens BEFORE any network call — including the OAuth2
 * token exchange, so an off-origin target never even mints a token.
 *
 * Also owns the module-level OAuth2 client-credentials token cache (moved
 * from `mcpClient.ts`, which re-exports `getOAuth2ClientCredentialsToken`).
 */
import { createHash } from 'node:crypto';
import { safeFetch } from '../urlSafety';
import type { SafeFetchInit } from '../urlSafety';
import type { ToolSourceAuthConfig } from './secrets';

export type OriginMismatchBehaviour = 'throw' | 'omit';
export type ToolSourceAuthErrorCode = 'origin_mismatch' | 'auth';

export class ToolSourceAuthError extends Error {
  constructor(message: string, readonly code: ToolSourceAuthErrorCode) {
    super(message);
    this.name = 'ToolSourceAuthError';
  }
}

type FetchImpl = (url: string, init: SafeFetchInit) => Promise<Response>;

/**
 * Module-level cache of OAuth2 client-credentials tokens.
 *
 * The key covers the WHOLE credential, not just (tokenUrl, clientId): two
 * tenants may legitimately register the same authorization server and the same
 * client id with DIFFERENT secrets or scopes (a shared SaaS vendor, separate
 * subscriptions). Keying on the identifier alone would hand tenant B an access
 * token minted from tenant A's secret — a cross-tenant credential leak with no
 * error anywhere. The secret is hashed so the cache key itself is not a place
 * a credential can be read out of (heap dumps, debugger, log of Map keys).
 */
const oauthTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function oauthCacheKey(cfg: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([cfg.tokenUrl, cfg.clientId, cfg.clientSecret, cfg.scope ?? '']))
    .digest('hex');
}

/** 30s of slack so a token about to expire mid-request is refreshed instead of reused. */
const OAUTH_EXPIRY_SKEW_MS = 30_000;

export async function getOAuth2ClientCredentialsToken(
  cfg: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string },
  fetchImpl: FetchImpl,
): Promise<{ accessToken: string; expiresAt: number }> {
  const cacheKey = oauthCacheKey(cfg);
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...(cfg.scope ? { scope: cfg.scope } : {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw new ToolSourceAuthError(`oauth2 token request failed: ${err instanceof Error ? err.message : String(err)}`, 'auth');
  }

  if (!res.ok) {
    throw new ToolSourceAuthError(`oauth2 token request failed with status ${res.status}`, 'auth');
  }

  let json: { access_token?: string; expires_in?: number };
  try {
    json = (await res.json()) as { access_token?: string; expires_in?: number };
  } catch {
    throw new ToolSourceAuthError('oauth2 token response was not valid JSON', 'auth');
  }
  if (!json.access_token) {
    throw new ToolSourceAuthError('oauth2 token response missing access_token', 'auth');
  }

  const ttlMs = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in * 1000 : 3_600_000;
  const token = { accessToken: json.access_token, expiresAt: Date.now() + ttlMs - OAUTH_EXPIRY_SKEW_MS };
  oauthTokenCache.set(cacheKey, token);
  return token;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Headers carrying `auth` for a request to `targetUrl`, or `{}` for
 * `authKind: 'none'`. When `targetUrl`'s origin is not exactly
 * `credentialOrigin` (scheme + host + port), the default is to THROW
 * `origin_mismatch`; `onOriginMismatch: 'omit'` returns `{}` instead — used
 * only by the OpenAPI spec fetch, where a document served from a docs host is
 * fetched anonymously rather than failing discovery.
 */
export async function buildToolSourceAuthHeaders(
  auth: ToolSourceAuthConfig,
  targetUrl: string,
  credentialOrigin: string,
  opts?: { onOriginMismatch?: OriginMismatchBehaviour; fetchImpl?: FetchImpl },
): Promise<Record<string, string>> {
  if (auth.authKind === 'none') return {};

  if (originOf(targetUrl) !== credentialOrigin) {
    if ((opts?.onOriginMismatch ?? 'throw') === 'omit') return {};
    throw new ToolSourceAuthError(
      `refusing to attach credentials: target origin does not match the credential's origin (${credentialOrigin})`,
      'origin_mismatch',
    );
  }

  switch (auth.authKind) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'api_key_header':
      return { [auth.headerName]: auth.value };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
    case 'oauth2_client_credentials': {
      const { accessToken } = await getOAuth2ClientCredentialsToken(
        { tokenUrl: auth.tokenUrl, clientId: auth.clientId, clientSecret: auth.clientSecret, scope: auth.scope },
        opts?.fetchImpl ?? safeFetch,
      );
      return { Authorization: `Bearer ${accessToken}` };
    }
    default:
      // Unreachable for a well-typed config; never send a request
      // unauthenticated because a stored auth kind is unknown to this build.
      throw new ToolSourceAuthError(`unsupported auth kind: ${String((auth as { authKind?: unknown }).authKind)}`, 'auth');
  }
}
