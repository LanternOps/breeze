-- AI Suggested Fixes W2: REVIEWED generic manual steps — the only way manual
-- steps can reach shareable fix memory (spec: "reviewed generic steps; no
-- model prose from any org"). A partner operator re-authors AI-written steps
-- into a row here; fix_outcomes.instructions_ref then points at its id.
--
-- Tenancy shape 3 (partner-axis): partner_id NOT NULL and no organization
-- column, so no org cascade/merge/export registration; partner deletion
-- discovers it via its partner_id column. Org users need READ (the panel
-- renders reviewed steps), which breeze_has_partner_access never grants an
-- org token, so a SEPARATE SELECT-only branch on breeze_current_partner_id()
-- is added — never folded into the FOR ALL policy (that would widen
-- UPDATE/DELETE targeting).
-- Idempotent; no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS fix_instructions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  title        varchar(160) NOT NULL,
  steps        text[] NOT NULL,
  os_type      varchar(20),
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fix_instructions_steps_chk CHECK (cardinality(steps) BETWEEN 1 AND 12),
  CONSTRAINT fix_instructions_os_chk CHECK (os_type IS NULL OR os_type IN ('windows', 'macos', 'linux'))
);
CREATE INDEX IF NOT EXISTS fix_instructions_partner_idx ON fix_instructions (partner_id) WHERE retired_at IS NULL;

ALTER TABLE fix_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fix_instructions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fix_instructions_isolation ON fix_instructions;
CREATE POLICY fix_instructions_isolation ON fix_instructions
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
DROP POLICY IF EXISTS fix_instructions_partner_select ON fix_instructions;
CREATE POLICY fix_instructions_partner_select
  ON fix_instructions
  FOR SELECT
  USING (partner_id = public.breeze_current_partner_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON fix_instructions TO breeze_app;
