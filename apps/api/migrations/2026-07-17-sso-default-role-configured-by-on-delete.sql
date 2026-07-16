-- PR3 review M3 — sso_providers.default_role_configured_by FK: ON DELETE SET NULL.
--
-- 2026-07-16 added the column with a bare `REFERENCES users(id)` (NO ACTION).
-- Two reasons to make it SET NULL, both strictly safer:
--
--   1. FAIL CLOSED. default_role_configured_by names the admin whose LIVE
--      permission ceiling the SSO callback re-checks the delegated default role
--      against just before JIT-provisioning a user (SR2-10). If that account is
--      ever hard-deleted, NO ACTION would block the delete (FK 23503) while
--      SET NULL leaves the provider with an unresolvable principal — and
--      revalidateSsoDefaultRole refuses JIT on a NULL configurer
--      (`default_role_configurer_unknown`). A vanished configurer must revoke
--      the standing delegation, not preserve it; the repair path is for a
--      current admin to re-save the default role, which re-stamps the column.
--
--   2. No new FK-block class. User deletion is membership-only today
--      (DELETE /users/:id removes organization_users), so this is latent —
--      but a future hard-delete would otherwise be blocked by this edge.
--
-- Forward-only fix (the 2026-07-16 migration is shipped and must not be edited).
-- Idempotent: DROP CONSTRAINT IF EXISTS (both the Postgres default name and the
-- drizzle-style name, so it converges regardless of how the edge was created)
-- then re-add. Re-applying is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sso_providers'
      AND column_name = 'default_role_configured_by'
  ) THEN
    ALTER TABLE sso_providers
      DROP CONSTRAINT IF EXISTS sso_providers_default_role_configured_by_fkey;
    ALTER TABLE sso_providers
      DROP CONSTRAINT IF EXISTS sso_providers_default_role_configured_by_users_id_fk;
    ALTER TABLE sso_providers
      ADD CONSTRAINT sso_providers_default_role_configured_by_fkey
      FOREIGN KEY (default_role_configured_by)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END $$;
