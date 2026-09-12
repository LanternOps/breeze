import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Site-ceiling gate contract §3/§7E: every caller-facing write to an org-wide
 * governance object that carries an `approval_generation` column (webhooks,
 * software_policies, backup_configs) must bump it so a job already queued
 * against the OLD generation can tell — by comparing against the freshly
 * reloaded row — that it has been superseded by an edit, and skip acting on
 * stale config instead of enforcing/delivering against a shape that no
 * longer applies.
 *
 * Centralised here (rather than each write site hand-writing the `sql`
 * fragment) so a new write site cannot forget the bump by copy-pasting an
 * `updatedAt: new Date()`-only payload. See
 * `__tests__/site-ceiling-write-coverage.test.ts` for the mechanical guard
 * that every write site to one of these tables references
 * `approvalGeneration`.
 */
export function bumpApprovalGeneration(column: PgColumn): SQL {
  return sql`${column} + 1`;
}
