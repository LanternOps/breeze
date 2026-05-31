/**
 * Canonical reasons written to `devices.agentTokenSuspendedReason` when an
 * agent token is suspended. This is a security-relevant discriminator: the
 * tenant-reactivation path (tenantLifecycle.restore*) clears ONLY
 * `tenantSuspended` rows, so it must never be confused with `crossTenantProbe`
 * (the auto-suspension applied when a token sprays foreign session IDs —
 * recordCrossTenantDrop in agentWs.ts), which a reactivation must leave intact.
 *
 * Keeping these as a shared const-union — rather than bare string literals
 * scattered across agentAuth/agentWs/tenantLifecycle — makes that invariant
 * checkable at every producer instead of relying on prose comments.
 */
export const AGENT_TOKEN_SUSPEND_REASON = {
  /** Tenant (org/partner) was suspended/deleted. Reversible: cleared on reactivation. */
  tenantSuspended: 'tenant_suspended',
  /** Token observed probing another tenant's session IDs. NOT cleared by reactivation. */
  crossTenantProbe: 'cross-tenant-probe',
} as const;

export type AgentTokenSuspendReason =
  (typeof AGENT_TOKEN_SUSPEND_REASON)[keyof typeof AGENT_TOKEN_SUSPEND_REASON];
