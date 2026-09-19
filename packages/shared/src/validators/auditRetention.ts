import { z } from 'zod';

// Org audit-log retention policy (audit_retention_policies — issue #4633).
// The table shipped with the daily prune worker (apps/api/src/jobs/auditRetention.ts)
// but no API route or UI ever wrote a row, so retention is a silent no-op on
// every fresh install until an operator inserts one by hand in psql.
//
// Bounds match the established backup-retention convention
// (packages/shared/src/validators/backupTargets.ts): 1 day minimum (a
// retention of 0 would prune everything, including same-day rows, on the
// next run) and 3650 days (10 years) maximum, generous enough for the
// longest compliance-driven retention window we support elsewhere.
export const auditRetentionPolicySchema = z.object({
  retentionDays: z.number().int().min(1).max(3650),
});
export type AuditRetentionPolicyInput = z.infer<typeof auditRetentionPolicySchema>;

export interface OrgAuditRetentionPolicy {
  orgId: string;
  /** False when no row exists yet — the prune worker skips this org entirely. */
  configured: boolean;
  retentionDays: number;
  lastCleanupAt: string | null;
}
