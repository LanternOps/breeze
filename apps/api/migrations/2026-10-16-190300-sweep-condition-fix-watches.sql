-- Sweep-condition fix watches (#5751 W02, #5753) — spec §3.8.
--
-- A sweep run has no triggering alert, so a sweep-minted intent could never
-- open a verification episode and was credited `verified` unconditionally on
-- release (intentReleaseWorker.ts's `watchReleasedIntent`). These two columns
-- give a watch a SUBJECT to re-probe instead of an alert to watch.
--
-- alert_id is ALREADY nullable (2026-09-18-ai-agents-safety-controls.sql);
-- nothing here relaxes it.
-- device_id is ALREADY NOT NULL and carries the intent's scope_device_id for
-- these rows; there is deliberately no second device column — two device
-- columns with no precedence rule is how the wrong one gets read.
-- source_kind stays 'intent' so recordWatchVerdictEvidence keeps mapping these
-- to namespace 'policy_key' — the namespace the graduation ladder reads. A
-- third source_kind would silently move sweep evidence out of the ladder.
--
-- NO DML: an existing watch has subject_kind NULL, which IS the predicate for
-- "alert-anchored", so there is nothing to backfill and no `breeze.scope`
-- elevation is needed (migrationRlsScope.test.ts stays green untouched).

ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS subject_kind text;
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS subject_key  varchar(200);

-- Mirrors AI_SWEEP_KINDS in @breeze/shared. The two must be edited together —
-- same convention as ai_agent_schedules_kinds_chk. Asserted by
-- src/db/schema/aiAgentFixWatches.subjectKinds.test.ts, which parses this
-- file, so a kind added to one set and not the other reds in Test API.
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_subject_kind_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_subject_kind_chk
  CHECK (subject_kind IS NULL OR subject_kind IN (
    'disk_pressure','stale_agents','pending_reboots','failed_backups',
    'service_down','unpatched_critical'));

-- A subject is a (kind, key) pair or nothing at all. A half-record cannot be
-- probed and would silently grade as `unknown` forever.
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_subject_shape_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_subject_shape_chk
  CHECK ((subject_kind IS NULL) = (subject_key IS NULL));

-- A subject watch is always intent-anchored, so it rides the existing partial
-- intent_id UNIQUE for arbitration; this index serves the phase-1/phase-2
-- probe reads and the recurrence lookup by subject.
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_subject_idx
  ON ai_agent_fix_watches (org_id, device_id, subject_kind, subject_key)
  WHERE subject_kind IS NOT NULL;
