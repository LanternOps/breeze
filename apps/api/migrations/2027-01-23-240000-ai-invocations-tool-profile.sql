-- Tool profiles W03 (#11395, feature #11393): record, on every ledger row,
-- the tool profile the call ran under and the fingerprint of the exact tool
-- exposure (registered names, kept extras, schema compaction, prompt mode),
-- so the quality view can compare a constrained profile with `full` on live
-- traffic and tie a refused tool batch to the tool set that produced it.
--
-- tool_profile is the RESOLVED profile (full | standard | minimal | custom,
-- never auto); tool_exposure_fingerprint is 'full' for the identity exposure
-- or 16 hex chars (services/aiModels/toolExposure.ts). Both are NULL on rows
-- written before W03 and on ledger writers that run outside a tool exposure.
--
-- Provenance snapshots like prompt_profile: written once at INSERT, never
-- updated. ai_invocations_append_only compares to_jsonb(NEW) - 'org_id' with
-- OLD, so the new columns are covered without touching the trigger.
-- breeze_app's table-level SELECT/INSERT grants cover new columns; UPDATE
-- stays org_id-only (ensureAppRole.ts). Both columns are classified
-- `included` in CORE_TENANT_EXPORT_POLICY.ai_invocations.
--
-- No CHECK: a value CHECK on this hot ledger would need a NOT VALID add plus
-- a separate VALIDATE migration, and the writer is a single typed path.
--
-- ADD COLUMN without a default is metadata-only. Idempotent. Writes no rows.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS tool_profile text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS tool_exposure_fingerprint text;
