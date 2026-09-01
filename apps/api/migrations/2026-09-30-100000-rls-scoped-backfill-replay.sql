-- Replay two backfills under system scope so they take effect on managed Postgres.
--
-- 2026-09-11-b-incident-atomic-winners.sql and
-- 2026-09-25-c-recovery-authorization-subject.sql each UPDATE tables that are
-- ENABLE + FORCE ROW LEVEL SECURITY without first setting `breeze.scope`.
-- `breeze_current_scope()` defaults to 'none' and the deny-default policies
-- (0012-tenant-rls-deny-default.sql) apply to the table OWNER too, so on a
-- deployment whose DATABASE_URL is NOT a superuser (DigitalOcean / RDS managed
-- Postgres) both UPDATEs silently match zero rows: the RAISE WARNING reports a
-- truthful-looking "0" and the new columns keep their inserted defaults. For
-- incidents that reproduces the double-enrich/double-escalate bug the migration
-- exists to prevent; for the recovery tables it leaves legacy rows in the
-- 'pending' authorization state instead of classified. CI and the containerised
-- dev stack run as a superuser, which bypasses RLS and masks the gap.
--
-- Those two files are already content-hash immutable (shipped in an rc tag), so
-- this migration fixes forward: same predicates, same values, wrapped in the
-- same `set_config('breeze.scope','system', true)` pattern the other backfills in
-- this range use (e.g. 2026-09-29-100000-automation-policy-compliance-unique.sql).
-- Every statement is idempotent — on a database where the originals already ran
-- as a superuser this is a no-op, and the counts below record that.
--
-- `is_local = true` scopes the setting to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  enriched integer;
  escalated integer;
BEGIN
  UPDATE incidents SET timeline_enriched_at = updated_at
  WHERE timeline_enriched_at IS NULL
    AND timeline::jsonb @> '[{"type":"timeline_enriched"}]'::jsonb;
  GET DIAGNOSTICS enriched = ROW_COUNT;

  UPDATE incidents SET escalated_at = updated_at
  WHERE escalated_at IS NULL
    AND timeline::jsonb @> '[{"type":"incident_escalated"}]'::jsonb;
  GET DIAGNOSTICS escalated = ROW_COUNT;

  -- Always report, including 0: a 0 here on a fresh managed-Postgres upgrade is
  -- the evidence that the original backfill did run, not an RLS artifact.
  RAISE WARNING 'rls-scoped replay (incidents): backfilled % enriched / % escalated marker(s)', enriched, escalated;
END $$;

DO $$
DECLARE
  affected bigint;
BEGIN
  UPDATE recovery_tokens
  SET authorization_state = CASE
    WHEN status IN ('revoked', 'expired', 'used') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('revoked', 'expired', 'used') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: classified % legacy recovery_tokens authorization subjects', affected;

  UPDATE recovery_media_artifacts
  SET authorization_state = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: classified % legacy recovery_media_artifacts authorization subjects', affected;

  UPDATE recovery_boot_media_artifacts
  SET authorization_state = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: classified % legacy recovery_boot_media_artifacts authorization subjects', affected;

  UPDATE restore_jobs
  SET authorization_state = CASE
    WHEN status IN ('completed', 'failed', 'cancelled', 'partial') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('completed', 'failed', 'cancelled', 'partial') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: classified % legacy restore_jobs authorization subjects', affected;

  UPDATE dr_executions
  SET authorization_state = CASE
    WHEN status IN ('completed', 'failed', 'aborted') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('completed', 'failed', 'aborted') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: classified % legacy dr_executions authorization subjects', affected;

  UPDATE c2c_backup_jobs
  SET operation_kind = 'unknown',
  authorization_state = CASE
    WHEN status IN ('completed', 'failed') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('completed', 'failed') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: classified % legacy c2c_backup_jobs authorization subjects', affected;
END $$;
