import type { securityStatus } from '../../db/schema';
import type { ProtectionState } from '@breeze/shared';

export type { ProtectionState };

/**
 * Generic, vendor-neutral label the customer portal shows for any EDR
 * integration. No provider key, vendor name or product name may ever reach a
 * portal DTO (EDR provider framework W02, #8166).
 */
export const PORTAL_EDR_LABEL = 'Managed endpoint protection';
type SecurityProvider = (typeof securityStatus.$inferSelect)['provider'];

/**
 * Direct extraction of the posture report's device-protection rule
 * (`securityComplianceReport.ts`). Either managed-agent table (SentinelOne or
 * Huntress) takes precedence over status-row presence and native AV state. An
 * absent `security_status` row, or a row whose `realTimeProtection` is null
 * (the agent's AV collector failed, #8043/#8252), is 'unknown' — the caller
 * decides how to bucket that (the posture report folds it into "unprotected"
 * to preserve its existing public contract). Deliberately does NOT consume `updatedAt`, `now`,
 * or `maxSecurityStatusAgeDays`: this rule has no freshness gate.
 */
export function classifyDeviceProtection(input: {
  securityStatus: {
    provider: SecurityProvider;
    realTimeProtection: boolean | null;
  } | null;
  hasS1Agent: boolean;
  hasHuntressAgent: boolean;
  /**
   * EDR provider framework W02 (#8166): a linked `edr_endpoints` row that is
   * `health = 'healthy' AND online IS TRUE`. The caller computes this (SQL) and
   * passes false when the org's enableEdrVisibility flag is off. Unhealthy,
   * degraded, unknown or offline endpoints must arrive as false: they never
   * upgrade a device to protected. Optional so existing callers are unchanged.
   */
  hasEdrEndpoint?: boolean;
}): ProtectionState {
  if (input.hasS1Agent || input.hasHuntressAgent || input.hasEdrEndpoint === true) {
    return 'protected';
  }

  if (input.securityStatus === null || input.securityStatus.realTimeProtection === null) {
    return 'unknown';
  }

  return input.securityStatus.provider !== 'other' &&
    input.securityStatus.provider !== 'unknown' &&
    input.securityStatus.realTimeProtection === true
    ? 'protected'
    : 'unprotected';
}
