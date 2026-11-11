/**
 * One pure predicate for "may this Tier-3 MCP call become an action intent?"
 * (B-W04 D-B34). Used by tools/list, tools/call and whoami so the three can
 * never disagree: listed implies callable. The order of checks is the
 * reported reason's precedence (approval-extra is tested before the tier so
 * `collect_evidence`, registry tier 2 but escalated to 3, says
 * `approval_extra`, not `not_tier3`).
 */
import { createHash } from 'node:crypto';
import type { PrincipalKind } from '../middleware/auth';

export type McpOriginRef = `api_key:${string}` | `oauth_grant:${string}`;

/**
 * The binding key for an intent: equals the stored
 * `origin_principal_kind:origin_principal_id` columns. Null for principals
 * that can never own an intent (partner service principals, sessions, ...).
 */
export function mcpOriginRef(principal: PrincipalKind | undefined): McpOriginRef | null {
  if (!principal) return null;
  if (principal.kind === 'api_key') {
    if (principal.partnerServicePrincipalId || !principal.apiKeyId) return null;
    return `api_key:${principal.apiKeyId}`;
  }
  if (principal.kind === 'oauth_grant') {
    return principal.grantId ? `oauth_grant:${principal.grantId}` : null;
  }
  return null;
}

/**
 * 'mcp:v1:' + 64 hex chars = 71 chars; `idempotency_key` is unbounded text.
 *
 * `authEpoch` (#9758) is passed for an OAuth origin only: release refuses an
 * intent whose recorded auth_epoch no longer matches the user's, so a retry
 * after a bump must file a fresh intent rather than converge on the stale
 * live one. API-key keys are unchanged (no epoch in the preimage).
 */
export function mcpIntentIdempotencyKey(
  ref: McpOriginRef,
  toolName: string,
  argumentDigest: string,
  authEpoch?: number,
): string {
  const epochPart = authEpoch === undefined ? '' : `:e${authEpoch}`;
  return `mcp:v1:${createHash('sha256').update(`${ref}${epochPart}:${toolName}:${argumentDigest}`).digest('hex')}`;
}

export type McpIntentEligibilityInput = {
  flagOn: boolean;
  ref: McpOriginRef | null;
  isServiceKey: boolean;
  toolName: string;
  registryTier: number | undefined;
  effectiveTier: number;
  isTenantTool: boolean;
  isBootstrapTool: boolean;
  isApprovalExtra: boolean;
  mfaRefused: boolean;
  scopes: readonly string[];
  requireExecuteAdmin: boolean;
  allowedInProd: boolean;
  isProduction: boolean;
};

export type McpIntentIneligibleReason =
  | 'flag_off' | 'principal_not_supported' | 'not_tier3' | 'tenant_tool' | 'bootstrap_tool'
  | 'approval_extra' | 'mfa_required' | 'scope' | 'not_allowlisted';

export function isMcpIntentEligible(
  i: McpIntentEligibilityInput,
): { ok: true } | { ok: false; reason: McpIntentIneligibleReason } {
  const no = (reason: McpIntentIneligibleReason) => ({ ok: false as const, reason });
  if (!i.flagOn) return no('flag_off');
  if (i.ref === null || i.isServiceKey) return no('principal_not_supported');
  if (i.isTenantTool) return no('tenant_tool');
  if (i.isBootstrapTool) return no('bootstrap_tool');
  if (i.isApprovalExtra) return no('approval_extra');
  if (i.effectiveTier !== 3) return no('not_tier3');
  if (i.mfaRefused) return no('mfa_required');
  if (!i.scopes.includes('ai:execute') || (i.requireExecuteAdmin && !i.scopes.includes('ai:execute_admin'))) {
    return no('scope');
  }
  if (i.isProduction && !i.allowedInProd) return no('not_allowlisted');
  return { ok: true };
}

/**
 * True for an intent filed by an MCP credential (B-W04). `source` alone is not
 * enough: agent-run and AI-operator intents are also `mcp_api` (for the 24 h
 * window) but are requested by a user session. Only the recorded origin
 * principal says an API key or OAuth grant asked.
 */
export function isMcpOriginIntent(intent: {
  source: string;
  originPrincipalKind: string;
}): boolean {
  return intent.source === 'mcp_api'
    && (intent.originPrincipalKind === 'api_key' || intent.originPrincipalKind === 'oauth_grant');
}
