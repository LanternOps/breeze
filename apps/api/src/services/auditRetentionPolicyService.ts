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
 * Creates or updates the caller's org policy.
 *
 * Uses a real `INSERT ... ON CONFLICT (org_id) DO UPDATE`, backed by the
 * unique constraint added in migration 2026-10-08-100400. An earlier version
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
): Promise<OrgAuditRetentionPolicy> {
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
