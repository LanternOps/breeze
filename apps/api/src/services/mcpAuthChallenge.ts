/**
 * `WWW-Authenticate` builders and the dormant `insufficient_scope` step-up for
 * the MCP endpoint (B-W02 #6156, D-B7).
 *
 * - Every MCP 401 carries a Bearer challenge naming `realm`, the protected
 *   resource metadata URL and `scope="mcp:read mcp:write mcp:execute"` — the
 *   same set as `scopes_supported`, so a client requests exactly what it does
 *   today. Narrow the default once the 403 step-up is on by default.
 * - When `MCP_INSUFFICIENT_SCOPE_HTTP_403=true` (default off, read per call),
 *   an OAuth bearer's `tools/call` refused ONLY for a missing tier scope
 *   (ai:write / ai:execute) answers HTTP 403 with an `insufficient_scope`
 *   challenge naming the bearer's current mcp scopes plus the missing one. The
 *   JSON-RPC error stays in the body. X-API-Key callers, domain denials,
 *   approval, MFA, RBAC, allowlist and ai:execute_admin denials never produce
 *   a scope challenge: re-authorizing cannot fix them.
 */
import type { Context } from 'hono';
import { OAUTH_ISSUER } from '../config/env';

export const MCP_DEFAULT_CHALLENGE_SCOPES = ['mcp:read', 'mcp:write', 'mcp:execute'] as const;

export function buildBearerChallenge(
  opts: { error?: 'invalid_token' | 'insufficient_scope'; scope?: readonly string[] } = {},
): string {
  const parts = ['realm="breeze"'];
  if (opts.error) parts.push(`error="${opts.error}"`);
  parts.push(`resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource"`);
  parts.push(`scope="${(opts.scope ?? MCP_DEFAULT_CHALLENGE_SCOPES).join(' ')}"`);
  return `Bearer ${parts.join(', ')}`;
}

const AI_TO_MCP_SCOPE: Readonly<Record<string, string>> = {
  'ai:read': 'mcp:read',
  'ai:write': 'mcp:write',
  'ai:execute': 'mcp:execute',
};

/**
 * The mcp scope a tier-scope denial asks for. `ai:execute_admin` has no
 * mapping: OAuth can never grant it, so a step-up could never succeed.
 */
export function requiredMcpScopesFor(aiScope: string): string[] {
  return aiScope === 'ai:write' || aiScope === 'ai:execute' ? [AI_TO_MCP_SCOPE[aiScope]!] : [];
}

type ChallengePrincipal = { oauthGrantId?: string | null; scopes?: readonly string[] } | undefined;
type ChallengeResponse = { error?: { data?: unknown } };

/**
 * Sets the 403 step-up challenge when, and only when, every condition holds.
 * Returns the HTTP status the caller must answer with (200 otherwise).
 */
export function applyInsufficientScopeChallenge(
  c: Pick<Context, 'header'>,
  apiKey: ChallengePrincipal,
  response: ChallengeResponse,
): 200 | 403 {
  if (process.env.MCP_INSUFFICIENT_SCOPE_HTTP_403 !== 'true') return 200;
  if (!apiKey?.oauthGrantId) return 200;
  const data = response.error?.data as { reason?: unknown; requiredScope?: unknown } | undefined;
  if (data?.reason !== 'insufficient_scope' || typeof data.requiredScope !== 'string') return 200;
  const required = requiredMcpScopesFor(data.requiredScope);
  if (required.length === 0) return 200;

  const current = (apiKey.scopes ?? []).map((s) => AI_TO_MCP_SCOPE[s]).filter((s): s is string => Boolean(s));
  const scope = MCP_DEFAULT_CHALLENGE_SCOPES.filter((s) => current.includes(s) || required.includes(s));
  c.header('WWW-Authenticate', buildBearerChallenge({ error: 'insufficient_scope', scope }));
  return 403;
}
