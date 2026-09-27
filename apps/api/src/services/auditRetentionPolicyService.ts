// Owns the per-org audit-log retention policy (audit_retention_policies —
// issue #4633). The daily prune worker (jobs/auditRetention.ts) only acts on
// orgs that have a row here; before this service existed nothing ever wrote
// one, so retention was a silent no-op on every fresh install.

import { eq } from 'drizzle-orm';
import type { OrgAuditRetentionPolicy } from '@breeze/shared';
import { auditRetentionPolicies } from '../db/schema';
import { db } from '../db';

const DEFAULT_RETENTION_DAYS = 365; // matches the column default in the schema

/**
 * Floor below which an org-scoped caller may not set its OWN retention. Org
 * Admin is a lower-trust principal than the partner/MSP that services the
 * org: `audit:manage` is seeded onto the customer-side Org Admin role
 * (`db/seed.ts`), and the org's own audit trail records the MSP technicians'
 * actions on that org just as much as the org's own users'. With no floor,
 * that principal could set `retentionDays: 1` and have the whole trail —
 * including everyone else's actions recorded under it — pruned within the
 * next `jobs/auditRetention.ts` run. A partner- or system-scope caller
 * acting on the SAME route is unaffected by this floor (see
 * `enforceOrgFloor` below) — the higher-trust principal keeps the full
 * 1..3650 range the validator already allows.
 *
 * 90 days is the recommended default. A partner-level minimum-floor
 * override and a grace-delay-with-partner-notice on a REDUCTION are two
 * further steps that could build on this; neither is implemented here (no
 * partner-configurable floor table or notification plumbing exists yet).
 */
export const AUDIT_RETENTION_ORG_FLOOR_DAYS = 90;

export class AuditRetentionFloorError extends Error {
  constructor(public readonly floorDays: number) {
    super(`retentionDays must be at least ${floorDays} for an organization-scoped caller`);
    this.name = 'AuditRetentionFloorError';
  }
}

/**
 * Reads the caller's org policy under its own RLS context. Returns a
 * "virtual" unconfigured row (configured: false) when none exists yet, so the
 * UI can tell the operator retention is not actually running rather than
 * silently showing the column default as if it were active.
 */
export async function getOrgAuditRetentionPolicy(orgId: string): Promise<OrgAuditRetentionPolicy> {
  const rows = await db
    .select({
      retentionDays: auditRetentionPolicies.retentionDays,
      lastCleanupAt: auditRetentionPolicies.lastCleanupAt,
    })
    .from(auditRetentionPolicies)
    .where(eq(auditRetentionPolicies.orgId, orgId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { orgId, configured: false, retentionDays: DEFAULT_RETENTION_DAYS, lastCleanupAt: null };
  }
  return {
    orgId,
    configured: true,
    retentionDays: row.retentionDays,
    lastCleanupAt: row.lastCleanupAt ? row.lastCleanupAt.toISOString() : null,
  };
}

/**
 * Creates or updates the caller's org policy.
 *
 * Uses a real `INSERT ... ON CONFLICT (org_id) DO UPDATE`, backed by the
 * unique constraint added in migration 2026-10-08-100700. An earlier version
 * of this function used `SELECT ... FOR UPDATE` inside a transaction instead,
 * reasoning that the row lock made concurrent saves for the same org safe —
 * that reasoning was wrong for an org with NO row yet (the exact case #4633
 * exists to fix): `SELECT ... FOR UPDATE` only locks rows that already
 * exist, so two concurrent requests both see "no row" and both INSERT,
 * producing duplicates with nothing to prevent it. `ON CONFLICT` is atomic
 * regardless of whether a row already exists, so it closes that gap.
 */
export async function upsertOrgAuditRetentionPolicy(
  orgId: string,
  retentionDays: number,
  opts?: { enforceOrgFloor?: boolean },
): Promise<OrgAuditRetentionPolicy> {
  if (opts?.enforceOrgFloor && retentionDays < AUDIT_RETENTION_ORG_FLOOR_DAYS) {
    throw new AuditRetentionFloorError(AUDIT_RETENTION_ORG_FLOOR_DAYS);
  }
  const [saved] = await db
    .insert(auditRetentionPolicies)
    .values({ orgId, retentionDays })
    .onConflictDoUpdate({
      target: auditRetentionPolicies.orgId,
      set: { retentionDays, updatedAt: new Date() },
    })
    .returning({
      retentionDays: auditRetentionPolicies.retentionDays,
      lastCleanupAt: auditRetentionPolicies.lastCleanupAt,
    });

  return {
    orgId,
    configured: true,
    retentionDays: saved!.retentionDays,
    lastCleanupAt: saved!.lastCleanupAt ? saved!.lastCleanupAt.toISOString() : null,
  };
}
