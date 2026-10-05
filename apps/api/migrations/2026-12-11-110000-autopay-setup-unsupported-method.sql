-- Autopay setup outcome `unsupported_method` (#7894).
--
-- Setup completion now refuses a captured card that collection admission could
-- never charge (a Link wallet card, or an unknown wallet or card network). The
-- attempt is terminally recorded as `unsupported_method`; no method, consent,
-- stop token or enrollment notice is created, and the working method is kept.
--
-- DDL only: no rows are written, so no system-scope elevation is needed.
-- Idempotent: the CHECK is dropped and re-added with the widened list.
ALTER TABLE autopay_setup_attempts DROP CONSTRAINT IF EXISTS autopay_setup_attempts_outcome_check;
ALTER TABLE autopay_setup_attempts ADD CONSTRAINT autopay_setup_attempts_outcome_check
 CHECK(outcome IN ('activated','pending_verification','stale_generation','failed','in_progress','abandoned','unsupported_method'));
