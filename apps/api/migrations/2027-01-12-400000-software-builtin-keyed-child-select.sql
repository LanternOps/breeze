-- #10036: an org-scope caller can read its partner's keyed built-in catalog
-- row but not that row's versions.
--
-- A keyed built-in (software_catalog.builtin_package_key IS NOT NULL, #6958)
-- is partner-owned: org_id NULL, partner_id = P. An org-scope session already
-- sees the row through software_catalog_partner_wide_select
-- (2026-10-11-000200, `org_id IS NULL AND partner_id =
-- breeze_current_partner_id()`). The child tables have no matching branch.
-- Their breeze_org_isolation_select policies (2026-07-02, 2026-08-16-a) cover
-- the org axis, the partner axis (breeze_has_partner_access, which an org token
-- never passes) and integration_provider built-ins only. So
-- GET /software/catalog/:id returns 200 for the row and its versions list is
-- empty, which leaves a card that cannot be deployed.
--
-- Fix: one additive, FOR SELECT only policy per child table. It lets a caller
-- read the children of a keyed built-in owned by the caller's OWN partner,
-- keyed on the same GUC as the parent row's read branch.
--
--   * SELECT only. Postgres never consults a FOR SELECT policy for
--     UPDATE/DELETE row targeting or INSERT WITH CHECK, so the existing write
--     policies stay the only way to write these rows. Built-in versions stay
--     immutable outside system scope (route guard isImmutableBuiltin, #9983).
--   * Keyed rows only. An un-keyed partner-wide custom package's versions stay
--     partner-axis only. This file does not widen them.
--   * `=` and not `IS NOT DISTINCT FROM`: a NULL breeze.current_partner_id
--     matches nothing.
--   * The EXISTS sub-select on software_catalog runs under software_catalog's
--     own RLS. It adds no visibility the parent row's policies do not already
--     grant.
--   * Agent sessions set currentPartnerId to the device's partner
--     (middleware/agentAuth.ts), so an agent can read its own partner's keyed
--     built-in versions too. That is the same reach it has to the parent row.
--
-- The existing policies stay byte-identical. This file only creates new names.
-- Writes no rows, so it needs no breeze.scope elevation
-- (src/db/migrationRlsScope.test.ts).
--
-- Idempotent: DROP POLICY IF EXISTS, then CREATE. No inner BEGIN/COMMIT;
-- autoMigrate wraps each file in a transaction.
--
-- Rollback: a new migration that drops the two policies below.

DROP POLICY IF EXISTS software_versions_builtin_keyed_select ON public.software_versions;
CREATE POLICY software_versions_builtin_keyed_select
  ON public.software_versions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.software_catalog sc
      WHERE sc.id = software_versions.catalog_id
        AND sc.builtin_package_key IS NOT NULL
        AND sc.org_id IS NULL
        AND sc.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS software_install_methods_builtin_keyed_select ON public.software_install_methods;
CREATE POLICY software_install_methods_builtin_keyed_select
  ON public.software_install_methods
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.software_catalog sc
      WHERE sc.id = software_install_methods.catalog_id
        AND sc.builtin_package_key IS NOT NULL
        AND sc.org_id IS NULL
        AND sc.partner_id = public.breeze_current_partner_id()
    )
  );
