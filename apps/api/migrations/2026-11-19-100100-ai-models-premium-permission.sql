-- ai_models:premium (#7598 W03, spec §5.3 / §15 #7). resolveModel checks an
-- offering's required_permission for user-initiated calls; this is the seeded
-- key a partner grants deliberately (premium / fast-mode models).
--
-- Granted to NO role: wildcard roles already match it at runtime (per-axis
-- grant matching), everyone else needs an explicit role edit.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action), only a
-- primary key on id, so a conflict-target upsert would add a duplicate row on
-- every re-apply. Explicit existence check instead. Idempotent; no inner
-- transaction (autoMigrate wraps the file).
--
-- System scope first: the insert would otherwise abort with 42501 on a
-- connection that does not bypass RLS (#4518). is_local = true scopes it to
-- autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- The description is normative and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts.
DO $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'ai_models' AND action = 'premium'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('ai_models', 'premium', 'Use AI model offerings that require the premium-model permission');
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  IF n > 0 THEN
    RAISE NOTICE 'seeded permission ai_models:premium';
  END IF;
END $$;
