-- Partner-wide READ branch on the identity/contracts config tables — the
-- follow-up group of epic #4673.
--
--   #4959 sso_providers
--   #4960 ticket_forms
--   #4961 contract_templates
--   #4962 contract_template_versions
--   #4963 psa_connections
--   #4970 access_reviews
--
-- All six carry `org_id` XOR `partner_id` directly on the row, so each takes
-- the direct-column form of the branch. A partner-wide row (`org_id NULL,
-- partner_id = P`) is invisible to an ORG-scoped session of P today:
-- `breeze_has_org_access(NULL)` is false, and `breeze_has_partner_access(P)` is
-- false because org scope carries an empty `accessible_partner_ids`. Readers
-- therefore escalate through the #1105 pattern
-- (`runOutsideDbContext(() => withSystemDbAccessContext(...))`), which
-- double-holds a pooled connection under the request's own transaction and
-- bypasses RLS entirely.
--
-- The fix and every design decision behind it are documented in full in the
-- template this file follows:
-- 2026-10-05-110000-config-policy-partner-wide-select.sql. In short — a
-- SELECT-only own-partner branch keyed on `public.breeze_current_partner_id()`
-- (created by 2026-06-13-catalog-partner-read-branch.sql; NOT recreated here),
-- added as a SEPARATE permissive policy per table. Appending the branch to an
-- existing FOR ALL `USING` would also widen UPDATE/DELETE row targeting, so an
-- org admin could rewrite or delete their MSP's shared rows; Postgres never
-- consults a FOR SELECT policy when computing write targets, so a separate
-- policy ORs into reads and nothing else. Existing policies are left
-- byte-identical.
--
-- Scope behaviour: org scope fires for its own partner's partner-wide rows;
-- partner scope is already covered by `breeze_has_partner_access` (redundant
-- but harmless — permissive policies OR); system scope short-circuits earlier;
-- agent scope leaves the GUC NULL, and `partner_id = NULL` is NULL, never true
-- (this is why the predicate uses `=` and not `IS NOT DISTINCT FROM`).
--
-- Writes no rows, so no `breeze.scope` elevation is needed.
-- Idempotent: DROP POLICY IF EXISTS then CREATE, so re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
--
-- Functional proof: identityContractsPartnerWideSelect.integration.test.ts.
-- Shape contract: rls-coverage.integration.test.ts (these six tables left
-- PARTNER_WIDE_SELECT_BRANCH_EXEMPT in the same change).
--
-- Rollback: a new migration issuing the six matching
-- `DROP POLICY IF EXISTS <table>_partner_wide_select` statements. The policies
-- are purely additive and no application code depends on them yet.

DROP POLICY IF EXISTS sso_providers_partner_wide_select ON public.sso_providers;
CREATE POLICY sso_providers_partner_wide_select
  ON public.sso_providers
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS ticket_forms_partner_wide_select ON public.ticket_forms;
CREATE POLICY ticket_forms_partner_wide_select
  ON public.ticket_forms
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS contract_templates_partner_wide_select ON public.contract_templates;
CREATE POLICY contract_templates_partner_wide_select
  ON public.contract_templates
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS contract_template_versions_partner_wide_select ON public.contract_template_versions;
CREATE POLICY contract_template_versions_partner_wide_select
  ON public.contract_template_versions
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS psa_connections_partner_wide_select ON public.psa_connections;
CREATE POLICY psa_connections_partner_wide_select
  ON public.psa_connections
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS access_reviews_partner_wide_select ON public.access_reviews;
CREATE POLICY access_reviews_partner_wide_select
  ON public.access_reviews
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
