import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { RestorePointStatus } from '@breeze/shared';

/**
 * The slice of a System Restore ledger row the inline badges need (#4759 W08).
 * Same field names as the agent-reported `RestorePointOutcome`, so the web
 * badge renders a stored command-result outcome and a ledger row identically.
 * `status` may be 'requested' (the server asked; no device report yet).
 */
export interface InlineRestorePoint {
  status: RestorePointStatus;
  requestId: string;
  attemptedAt: string | null;
  durationMs: number | null;
  message: string | null;
  existingPointAgeMinutes: number | null;
  frequencyMinutes: number | null;
}

// Correlated scalar subquery over the ledger. The inner table is aliased and
// referenced by raw identifiers so it can never be confused with the outer
// query's own columns (drizzle drops table qualifiers on single-table
// selects). Only the caller-supplied outer expressions are parameterised.
// Runs on the ambient request connection, so the ledger's RLS applies.
// `message` is agent free text, redacted at ingest; the web renders it as text.
function newestAttempt(match: SQL): SQL<InlineRestorePoint | null> {
  return sql<InlineRestorePoint | null>`(
    select json_build_object(
      'status', rpa.status,
      'requestId', rpa.request_id,
      'attemptedAt', rpa.attempted_at,
      'durationMs', rpa.duration_ms,
      'message', rpa.message,
      'existingPointAgeMinutes', rpa.existing_point_age_minutes,
      'frequencyMinutes', rpa.frequency_minutes
    )
    from device_restore_point_attempts rpa
    where ${match}
    order by rpa.requested_at desc, rpa.request_id desc
    limit 1
  )`;
}

/** Newest ledger row for a script execution, or NULL when Breeze never asked. */
export function scriptExecutionRestorePointSql(executionId: SQLWrapper): SQL<InlineRestorePoint | null> {
  return newestAttempt(sql`rpa.script_execution_id = ${executionId}`);
}

/** Newest ledger row for one device's result within a software deployment. */
export function deploymentResultRestorePointSql(
  deploymentId: SQLWrapper,
  deviceId: SQLWrapper,
): SQL<InlineRestorePoint | null> {
  return newestAttempt(sql`rpa.software_deployment_id = ${deploymentId} and rpa.device_id = ${deviceId}`);
}
