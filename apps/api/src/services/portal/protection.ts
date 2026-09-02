import type { securityStatus } from '../../db/schema';

type SecurityProvider = (typeof securityStatus.$inferSelect)['provider'];

export type ProtectionState =
  | 'protected'
  | 'unprotected'
  | 'unknown';

/**
 * Direct extraction of the posture report's device-protection rule
 * (`securityComplianceReport.ts`). Either managed-agent table (SentinelOne or
 * Huntress) takes precedence over status-row presence and native AV state. An
 * absent `security_status` row is 'unknown' — the caller decides how to bucket
 * that (the posture report folds it into "unprotected" to preserve its
 * existing public contract). Deliberately does NOT consume `updatedAt`, `now`,
 * or `maxSecurityStatusAgeDays`: this rule has no freshness gate.
 */
export function classifyDeviceProtection(input: {
  securityStatus: {
    provider: SecurityProvider;
    realTimeProtection: boolean | null;
  } | null;
  hasS1Agent: boolean;
  hasHuntressAgent: boolean;
}): ProtectionState {
  if (input.hasS1Agent || input.hasHuntressAgent) {
    return 'protected';
  }

  if (input.securityStatus === null) {
    return 'unknown';
  }

  return input.securityStatus.provider !== 'other' &&
    input.securityStatus.realTimeProtection === true
    ? 'protected'
    : 'unprotected';
}
