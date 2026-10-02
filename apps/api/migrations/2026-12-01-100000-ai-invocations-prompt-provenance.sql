-- AI model registry W11 (#7609, spec §7 "Prompt profile", §13 W11): record, on
-- every ledger row, the prompt profile the call was dispatched under and the
-- per-profile prompt variant that was appended to its system prompt (NULL =
-- the surface's base prompt), so the quality view can compare a variant with
-- its base prompt on live traffic.
--
-- All three columns are provenance snapshots like served_model: written once at
-- INSERT and never updated. ai_invocations_append_only compares
-- to_jsonb(NEW) - 'org_id' with OLD, so the new columns are covered without
-- touching the trigger. breeze_app's table-level SELECT/INSERT grants cover
-- new columns; UPDATE stays org_id-only (ensureAppRole.ts).
--
-- occurred_at is when the turn was first settled (toNewInvocations stamps one
-- instant per settlement). created_at is the INSERT time, which is late for a
-- settlement deferred under org-lock contention and replayed by the sweep
-- (aiBudgetReservations pending_settlement). The quality view orders a
-- conversation's calls by COALESCE(occurred_at, created_at). It is NOT a
-- billing-period key: chargeback and retention keep reading created_at.
--
-- A variant id is `<surface>/<profile>@<version>` (services/aiModels/
-- promptVariants.ts). The CHECK ties it to the row's own surface and profile,
-- and `generic` never carries one. The CHECK is added NOT VALID here and
-- validated by -100100 in its own transaction: autoMigrate wraps each file
-- in one transaction, and a same-file VALIDATE would hold this ALTER's
-- ACCESS EXCLUSIVE lock through a full scan of the hot ledger.
--
-- ADD COLUMN without a default is metadata-only. Idempotent. Writes no rows.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS prompt_profile text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS prompt_variant text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS occurred_at timestamptz;

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_prompt_provenance_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_prompt_provenance_chk CHECK (
  (prompt_profile IS NULL
    OR prompt_profile IN ('claude-frontier', 'claude-standard', 'claude-small', 'generic'))
  AND (prompt_variant IS NULL OR (
    prompt_profile IS NOT NULL
    AND prompt_profile <> 'generic'
    AND prompt_variant ~ '^[a-z_]+/[a-z-]+@[1-9][0-9]{0,3}$'
    AND split_part(prompt_variant, '/', 1) = surface
    AND split_part(split_part(prompt_variant, '/', 2), '@', 1) = prompt_profile
  ))
) NOT VALID;
