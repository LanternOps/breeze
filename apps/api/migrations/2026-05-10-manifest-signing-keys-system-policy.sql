-- Add a system-context-only RLS policy to manifest_signing_keys. The base
-- migration enabled FORCE RLS but added no policies, which (correctly)
-- denies all access — including from withSystemDbAccessContext, which
-- writes via the breeze_app role. This policy grants read/write only when
-- the session-level breeze.scope is 'system' (set by the API's system
-- DB context wrapper).
--
-- Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'manifest_signing_keys'
      AND policyname = 'manifest_signing_keys_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY manifest_signing_keys_system_only
        ON manifest_signing_keys
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
