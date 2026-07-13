/**
 * RFC 8707 resource-indicator alias handling (#2363).
 *
 * MCP clients (Claude Code and friends) are configured with the SSE
 * transport URL (`<resource>/sse`), not the canonical resource identifier
 * the provider issues grants for (`OAUTH_RESOURCE_URL`). Some clients send
 * that configured URL — or a trailing-slash / `/message` variant — as the
 * `resource` parameter on token-endpoint requests, while the authorization
 * request carried the canonical value. oidc-provider's refresh_token grant
 * then throws `invalid_target` (lib/helpers/resolve_resource.js: the
 * requested resource must exactly equal the refresh token's stored
 * resource), and because rotation happens BEFORE resource resolution, the
 * failed exchange also burns the refresh token — every MCP session died at
 * the first access-token expiry.
 *
 * The fix: treat a tight allowlist of known aliases as equivalent to the
 * canonical resource and normalize them to `OAUTH_RESOURCE_URL` before the
 * oidc-provider bridge sees the request. This is deliberately an EXACT
 * string allowlist — no prefix matching — so RFC 8707 audience binding is
 * not loosened: an unrelated resource value still reaches oidc-provider
 * unchanged and still fails `invalid_target`.
 */
import { OAUTH_RESOURCE_URL } from '../config/env';

/**
 * Known alias suffixes MCP clients append to the canonical resource:
 *   - `/sse`     — the SSE transport endpoint clients are configured with
 *   - `/`        — trailing-slash variant
 *   - `/message` — the HTTP message transport endpoint
 * Keep this list tight; every entry widens what we accept as "the same
 * audience".
 */
export const RESOURCE_INDICATOR_ALIAS_SUFFIXES = ['/sse', '/', '/message'] as const;

/** Canonical resource plus every accepted alias (exact strings). */
export function getAcceptedResourceIndicators(): string[] {
  if (!OAUTH_RESOURCE_URL) return [];
  return [
    OAUTH_RESOURCE_URL,
    ...RESOURCE_INDICATOR_ALIAS_SUFFIXES.map((suffix) => `${OAUTH_RESOURCE_URL}${suffix}`),
  ];
}

/** True when `value` is the canonical resource or an accepted alias of it. */
export function isAcceptedResourceIndicator(value: string): boolean {
  return getAcceptedResourceIndicators().includes(value);
}

/**
 * Map an accepted alias to the canonical `OAUTH_RESOURCE_URL`. Any value
 * that is not an exact alias (including the canonical value itself and any
 * unrelated resource) is returned unchanged.
 */
export function normalizeResourceIndicator(value: string): string {
  if (!OAUTH_RESOURCE_URL || value === OAUTH_RESOURCE_URL) return value;
  return RESOURCE_INDICATOR_ALIAS_SUFFIXES.some(
    (suffix) => value === `${OAUTH_RESOURCE_URL}${suffix}`,
  )
    ? OAUTH_RESOURCE_URL
    : value;
}

/**
 * Normalize every `resource` entry in `params` in place. Returns true when
 * at least one entry was rewritten. Order of the remaining params is
 * preserved by URLSearchParams semantics (rewritten `resource` entries are
 * re-appended at the end, which is irrelevant to form/query parsing).
 */
export function normalizeResourceParams(params: URLSearchParams): boolean {
  const resources = params.getAll('resource');
  if (resources.length === 0) return false;
  let changed = false;
  const normalized = resources.map((value) => {
    const next = normalizeResourceIndicator(value);
    if (next !== value) changed = true;
    return next;
  });
  if (!changed) return false;
  params.delete('resource');
  for (const value of normalized) params.append('resource', value);
  return true;
}

/**
 * Normalize the `resource` parameter(s) inside a raw
 * application/x-www-form-urlencoded body. Returns the re-serialized body
 * when a rewrite happened, or null when the body needs no change (so
 * callers can skip touching the buffered bytes entirely).
 */
export function normalizeFormEncodedResource(rawBody: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(rawBody);
  } catch {
    return null;
  }
  return normalizeResourceParams(params) ? params.toString() : null;
}
