/**
 * Guardrail adapters for tenant (BYO MCP) tools — Task A8.
 *
 * Bridges a `TenantToolDescriptor` into the shapes the existing AI guardrail
 * machinery (`services/aiGuardrails.ts`) already understands: a
 * `GuardrailCheck` (tier + approval posture), an `external_tools` RBAC
 * requirement, and a per-source-per-principal rate limit.
 */
import { rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';
import type { GuardrailCheck } from '../aiGuardrails';
import type { TenantToolDescriptor } from './resolver';

/**
 * Tier 1: allowed, read-only, no approval. Tier 2: allowed, requires
 * approval (auto-approved elsewhere per the caller's approval mode), not
 * read-only. Tier 3: allowed, requires approval, `approvalScope: 'supervised'`
 * — REQUIRED by the `GuardrailCheck` type's tier-3 arm.
 */
export function guardrailCheckForTenantTool(d: TenantToolDescriptor): GuardrailCheck {
  const description = `${d.qualifiedName} — external tool from ${d.sourceName}`;

  if (d.tier === 3) {
    return {
      tier: 3,
      allowed: true,
      requiresApproval: true,
      readOnly: false,
      description,
      approvalScope: 'supervised',
    };
  }

  return {
    tier: d.tier,
    allowed: true,
    requiresApproval: d.tier >= 2,
    readOnly: d.tier === 1,
    description,
  };
}

/**
 * The RBAC requirement for calling a tenant tool of this tier. Tier 1 is
 * read-only so it maps to `external_tools:use`; tiers 2-3 can mutate the
 * remote system, so they require `external_tools:write`.
 */
export function tenantToolPermissionRequirement(
  tier: 1 | 2 | 3,
): { resource: 'external_tools'; action: 'use' | 'write' } {
  return { resource: 'external_tools', action: tier === 1 ? 'use' : 'write' };
}

/**
 * Per-(sourceId, principal) rate limit, keyed off the tool source's own
 * configured `rateLimitPerMinute` (not a per-tool limit — every tool on one
 * source shares its source's budget). Returns `null` when allowed, or a
 * human-readable error string when throttled.
 */
export async function checkTenantToolRateLimit(
  d: TenantToolDescriptor,
  principalId: string,
): Promise<string | null> {
  const redis = getRedis();
  const key = `ai:exttool:${d.sourceId}:${principalId}`;
  const result = await rateLimiter(redis, key, d.rateLimitPerMinute, 60);
  if (!result.allowed) {
    return `Tool rate limit exceeded for ${d.qualifiedName}. Try again at ${result.resetAt.toISOString()}`;
  }
  return null;
}
