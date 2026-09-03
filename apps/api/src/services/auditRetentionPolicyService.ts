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
 * Creates or updates the caller's org policy. `audit_retention_policies` has
 * no unique constraint on `org_id` (it predates this feature — see the
 * baseline migration), so this can't use a Postgres-level upsert
 * (`ON CONFLICT`) without first adding one. A `SELECT ... FOR UPDATE` inside a
 * transaction gets the same one-row-per-org guarantee without a migration:
 * it serializes concurrent saves for the same org so two racing requests
 * can't both see "no row" and both INSERT.
 */
export async function upsertOrgAuditRetentionPolicy(
  orgId: string,
  retentionDays: number,
): Promise<OrgAuditRetentionPolicy> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: auditRetentionPolicies.id })
      .from(auditRetentionPolicies)
      .where(eq(auditRetentionPolicies.orgId, orgId))
      .limit(1)
      .for('update');

    if (existing[0]) {
      await tx
        .update(auditRetentionPolicies)
        .set({ retentionDays, updatedAt: new Date() })
        .where(eq(auditRetentionPolicies.id, existing[0].id));
    } else {
      await tx.insert(auditRetentionPolicies).values({ orgId, retentionDays });
    }

    const [saved] = await tx
      .select({
        retentionDays: auditRetentionPolicies.retentionDays,
        lastCleanupAt: auditRetentionPolicies.lastCleanupAt,
      })
      .from(auditRetentionPolicies)
      .where(eq(auditRetentionPolicies.orgId, orgId))
      .limit(1);

    return {
      orgId,
      configured: true,
      retentionDays: saved!.retentionDays,
      lastCleanupAt: saved!.lastCleanupAt ? saved!.lastCleanupAt.toISOString() : null,
    };
  });
}
