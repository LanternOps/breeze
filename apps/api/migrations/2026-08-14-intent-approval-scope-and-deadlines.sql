-- Spec docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
-- §4.1 / §9.1 — tier-3 supervised/four_eyes intent classification split.
--
-- Adds five columns to action_intents:
--   * approval_scope, classification_version: immutable classification
--     content, decided once at createIntent time from checkGuardrails'
--     approvalScope. Live pre-migration rows backfill via DEFAULT to
--     'four_eyes'/0 (spec §9.1: "Live pre-migration intents backfill as
--     four_eyes / version 0").
--   * effect_digest: immutable content-pinning hash for four_eyes intents
--     (script content hash / quote-invoice revision / target state-version,
--     pinned at creation; the release worker revalidates it and fails the
--     release with content_changed on drift). Supervised intents leave it
--     NULL (they skip pinning per spec).
--   * approval_expires_at: the pending-approval deadline, split out of the
--     single expires_at column (advisor-confirmed trap: a single expires_at
--     could reap an intent approved at 59:59 before the release worker
--     claims it). Lifecycle column — set at creation by application code
--     going forward; backfilled here from the legacy expires_at for rows
--     that predate the split.
--   * release_by: the execution lease deadline, stamped atomically by the
--     decide-path when an approval wins (Task 5). Lifecycle column.
--
-- approval_scope/classification_version/effect_digest are added to the
-- action_intents_immutable_trg deny-list (extending the function created in
-- 2026-07-18-action-intents.sql and already extended once in
-- 2026-08-06-e-action-intents-origin-principal.sql — CREATE OR REPLACE on
-- the existing function, no DROP/CREATE TRIGGER needed since the trigger
-- itself is unchanged, only the function body it points to). Existing
-- content columns are otherwise unchanged. approval_expires_at/release_by
-- are lifecycle columns and are deliberately NOT added to the deny-list —
-- release_by must remain writable when the decide-path stamps it, matching
-- the execution_started_at precedent from 2026-07-19.
--
-- Idempotent throughout: ADD COLUMN IF NOT EXISTS, DO-guarded constraint add,
-- CREATE OR REPLACE FUNCTION. autoMigrate wraps this file in one transaction
-- — no inner BEGIN/COMMIT.

ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS approval_scope text NOT NULL DEFAULT 'four_eyes';
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS classification_version integer NOT NULL DEFAULT 0;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS release_by timestamptz;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS effect_digest char(64);

DO $$ BEGIN
  ALTER TABLE action_intents ADD CONSTRAINT action_intents_approval_scope_chk
    CHECK (approval_scope IN ('supervised','four_eyes'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: pre-split rows are legacy four-eyes (spec §9.1); their approval
-- deadline is the old single deadline. approval_scope/classification_version
-- already land on these rows via the DEFAULTs above.
UPDATE action_intents SET approval_expires_at = expires_at
  WHERE approval_expires_at IS NULL;

-- Extend the immutability trigger's content deny-list: approval_scope,
-- classification_version, and effect_digest are decided once at creation and
-- must never be edited afterward (an editable approval_scope would let an
-- intent switch classification after approvers have already acted on the
-- original scope). release_by and approval_expires_at are intentionally
-- excluded — see header.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
