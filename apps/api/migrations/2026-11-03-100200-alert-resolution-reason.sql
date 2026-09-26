-- AI Suggested Fixes W1 (open item 5): WHY an alert resolved, persisted so the
-- outcome sweeper can distinguish an objective condition-clear from a human,
-- cleanup or expiry resolve after the fact. NULL = unspecified (pre-existing
-- rows and direct-UPDATE paths) and is treated as NOT a recovery (fail
-- closed). Nullable, no default: a metadata-only ALTER on a hot table.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_reason varchar(40);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_resolution_reason_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_resolution_reason_check CHECK (resolution_reason IN ('condition_cleared', 'source_retired', 'expired', 'manual')) NOT VALID;
