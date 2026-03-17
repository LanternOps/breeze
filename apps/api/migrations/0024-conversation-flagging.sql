ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS flagged_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS flag_reason TEXT;

CREATE INDEX IF NOT EXISTS ai_sessions_flagged_at_idx
  ON ai_sessions (flagged_at)
  WHERE flagged_at IS NOT NULL;
