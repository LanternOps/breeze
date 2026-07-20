-- Adds execution_started_at: the timestamp the release worker CASes the intent
-- approved -> executing. Stale-execution detection keys off this (not decided_at,
-- which can precede execution start). Lifecycle column — deliberately NOT added
-- to action_intents_immutable_trg (the deny-list trigger guards identity/content
-- columns only; lifecycle timestamps are mutable by design).
ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ;
