-- CIS hardening: recurring baseline scans carry a stored execution authority,
-- and the CIS write/remediate/approve routes now require devices:execute + MFA.
--
-- 1. cis_baselines gains the same creator-bound authority envelope as
--    sensitive_data_policies (version, kind, site ceiling, approving user,
--    fingerprint, capture time, generation). The scheduler dispatches a
--    baseline only when that envelope re-resolves live. Existing rows are NOT
--    backfilled — inventing an approver would defeat the point — so every
--    pre-existing scheduled baseline stops dispatching until a user with
--    devices:execute (and MFA) saves it once.
-- 2. Remediation actions approved under the old permission but not yet
--    dispatched (status 'queued', no command) return to pending approval so
--    they are approved once more under the new requirement.
--
-- Idempotent. Elects system scope before any write (FORCE ROW LEVEL SECURITY).

ALTER TABLE cis_baselines
  ADD COLUMN IF NOT EXISTS execution_authority_version integer,
  ADD COLUMN IF NOT EXISTS execution_authority_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_authority_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_authority_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_authority_principal_kind varchar(16),
  ADD COLUMN IF NOT EXISTS execution_authority_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_authority_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_authority_generation uuid;

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE cis_baselines
  DROP CONSTRAINT IF EXISTS cis_baselines_execution_authority_shape_chk;

ALTER TABLE cis_baselines
  ADD CONSTRAINT cis_baselines_execution_authority_shape_chk CHECK ((
    (
      execution_authority_version IS NULL
      AND execution_authority_kind IS NULL
      AND execution_authority_site_ids IS NULL
      AND execution_authority_user_id IS NULL
      AND execution_authority_principal_kind IS NULL
      AND execution_authority_fingerprint IS NULL
      AND execution_authority_captured_at IS NULL
      AND execution_authority_generation IS NULL
    )
    OR
    (
      execution_authority_version = 1
      AND execution_authority_fingerprint ~ '^[0-9a-f]{64}$'
      AND execution_authority_captured_at IS NOT NULL
      AND execution_authority_generation IS NOT NULL
      AND (
        (execution_authority_principal_kind = 'user' AND execution_authority_user_id IS NOT NULL)
        OR
        (execution_authority_principal_kind = 'system' AND execution_authority_user_id IS NULL)
      )
      AND (
        (
          org_id IS NOT NULL AND partner_id IS NULL
          AND execution_authority_kind = 'organization_restricted'
          AND execution_authority_site_ids IS NOT NULL
          AND cardinality(execution_authority_site_ids) > 0
        )
        OR
        (
          org_id IS NOT NULL AND partner_id IS NULL
          AND execution_authority_kind = 'organization_unrestricted'
          AND execution_authority_site_ids IS NULL
        )
        OR
        (
          org_id IS NULL AND partner_id IS NOT NULL
          AND execution_authority_kind = 'partner_unrestricted'
          AND execution_authority_site_ids IS NULL
        )
      )
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE cis_baselines
  VALIDATE CONSTRAINT cis_baselines_execution_authority_shape_chk;

DO $$
DECLARE
  pending_schedules bigint;
  returned_actions bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO pending_schedules
    FROM cis_baselines
   WHERE is_active = true
     AND COALESCE((scan_schedule->>'enabled')::boolean, true) = true
     AND execution_authority_generation IS NULL;
  IF pending_schedules > 0 THEN
    RAISE WARNING 'cis: % scheduled baseline(s) pending re-approval (no stored authority)', pending_schedules;
  END IF;

  UPDATE cis_remediation_actions
     SET status = 'pending_approval',
         approval_status = 'pending',
         approved_by = NULL,
         approved_at = NULL,
         approval_note = NULL,
         details = COALESCE(details, '{}'::jsonb)
           || jsonb_build_object('returnedForReapprovalAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   WHERE status = 'queued'
     AND approval_status = 'approved'
     AND command_id IS NULL;
  GET DIAGNOSTICS returned_actions = ROW_COUNT;
  IF returned_actions > 0 THEN
    RAISE WARNING 'cis: returned % undispatched approved remediation action(s) to pending approval', returned_actions;
  END IF;
END $$;
