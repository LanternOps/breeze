-- Add optional semantic idempotency keys for canonical ML feedback events.
-- Existing append-only timestamp dedupe remains unchanged for callers without
-- a stable domain key.

ALTER TABLE ml_feedback_events
  ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS ml_feedback_events_semantic_dedupe_uq
  ON ml_feedback_events (org_id, source_type, source_id, event_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
