CREATE TABLE IF NOT EXISTS user_avatar_drafts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  intent TEXT NOT NULL,
  mime TEXT,
  bytes BYTEA,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_avatar_drafts_shape_check CHECK (
    (intent = 'replace' AND mime IS NOT NULL AND mime IN ('image/png', 'image/jpeg', 'image/webp') AND bytes IS NOT NULL
      AND octet_length(bytes) BETWEEN 1 AND 5242880)
    OR (intent = 'remove' AND mime IS NULL AND bytes IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS user_avatar_drafts_expires_at_idx ON user_avatar_drafts (expires_at);
ALTER TABLE user_avatar_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_avatar_drafts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_avatar_drafts_select ON user_avatar_drafts;
DROP POLICY IF EXISTS user_avatar_drafts_insert ON user_avatar_drafts;
DROP POLICY IF EXISTS user_avatar_drafts_update ON user_avatar_drafts;
DROP POLICY IF EXISTS user_avatar_drafts_delete ON user_avatar_drafts;
CREATE POLICY user_avatar_drafts_select ON user_avatar_drafts FOR SELECT
  USING (user_id = public.breeze_current_user_id() OR public.breeze_current_scope() = 'system');
CREATE POLICY user_avatar_drafts_insert ON user_avatar_drafts FOR INSERT
  WITH CHECK (user_id = public.breeze_current_user_id() OR public.breeze_current_scope() = 'system');
CREATE POLICY user_avatar_drafts_update ON user_avatar_drafts FOR UPDATE
  USING (user_id = public.breeze_current_user_id() OR public.breeze_current_scope() = 'system')
  WITH CHECK (user_id = public.breeze_current_user_id() OR public.breeze_current_scope() = 'system');
CREATE POLICY user_avatar_drafts_delete ON user_avatar_drafts FOR DELETE
  USING (user_id = public.breeze_current_user_id() OR public.breeze_current_scope() = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_avatar_drafts TO breeze_app;
