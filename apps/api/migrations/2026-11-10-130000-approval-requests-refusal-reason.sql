-- approval_requests.refusal_reason: an approve the server refused is stored
-- as denied, with the reason.
--
-- A PAM elevation approve can be refused inside the decide transaction when
-- the target's identity cannot be verified (createPamDecisionIntent): the
-- elevation request is then denied. The approval row the approver decided
-- used to stay `approved`, so every reader of the row (the mobile app, the
-- approvals inbox's Recent panel) reported an approval that never took
-- effect. From this migration on, the decide path stores that row as
-- `denied` and records the refusal here. The approver's approve stays on the
-- row: user_id, decided_at, decided_via and decided_assurance_level describe
-- it, and decision_reason stays the approver's own reason. A non-null
-- refusal_reason is what tells "approved, then refused" apart from "the
-- approver denied".
--
-- Backfill: rows refused before this migration (the refusal shipped in
-- v0.118.0) are corrected the same way. They are identified through the
-- linked elevation request: denied with the refusal's exact denial_reason
-- (PAM_TARGET_HASH_UNVERIFIED_REASON in services/pamActuationLifecycle.ts,
-- unchanged since it shipped) and approved by this row's own approver.
-- Sibling rows of the same elevation are `expired`, never `approved`, so they
-- do not match. The count lands in the Postgres log.
--
-- approval_requests has no org_id and is in neither
-- CORE_ORG_CASCADE_DELETE_ORDER nor CORE_TENANT_EXPORT_POLICY, so this
-- ADD COLUMN carries no cascade or export-policy registration obligation.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, the backfill matches only rows still
-- `approved`, and the CHECK is added only when missing. autoMigrate wraps the
-- file in one transaction, so SET LOCAL covers every statement below.
SET LOCAL lock_timeout = '5s';

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS refusal_reason text;

DO $$
DECLARE
  n integer;
BEGIN
  -- approval_requests and elevation_requests use FORCE RLS, and
  -- migrations run as the table owner under breeze.scope='none', which sees
  -- ZERO rows: without this the UPDATE silently matches nothing.
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE approval_requests ar
     SET status = 'denied',
         refusal_reason = er.denial_reason
    FROM elevation_requests er
   WHERE ar.elevation_request_id = er.id
     AND ar.status = 'approved'
     AND er.status = 'denied'
     AND er.approved_by_user_id = ar.user_id
     AND er.denial_reason = 'Target identity could not be verified on the device; re-request elevation.';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'approval_requests: stored % refused approve(s) as denied with their refusal reason', n;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'approval_requests_refusal_reason_status_chk'
       AND conrelid = 'public.approval_requests'::regclass
  ) THEN
    ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_refusal_reason_status_chk
      CHECK (refusal_reason IS NULL OR status = 'denied');
  END IF;
END $$;

COMMENT ON COLUMN approval_requests.refusal_reason IS
  'Set when the approver approved but the server refused to apply it (the row is then denied). user_id, decided_at, decided_via and decided_assurance_level still describe the approver''s approve.';
