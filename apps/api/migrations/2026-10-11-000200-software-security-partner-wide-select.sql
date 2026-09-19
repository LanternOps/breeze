-- Partner-wide READ branch on the software + security policy tables
-- (#4946, #4947, #4948, #4953, #4954 — the software-security group of the
-- #4673 follow-up issues).
--
-- Same gap, same fix as wave 1 of #4673:
-- 2026-10-05-110000-config-policy-partner-wide-select.sql. Read that file's
-- header for the full rationale; the short version is that a partner-wide row
-- is `org_id NULL, partner_id = P`, and an ORG-scoped session cannot see it —
-- `breeze_has_org_access(NULL)` is false and `breeze_has_partner_access(P)` is
-- false because org scope carries an empty `accessible_partner_ids`. Readers
-- therefore escalate through the #1105 pattern
-- (`runOutsideDbContext(() => withSystemDbAccessContext(...))`), which
-- double-holds a pooled connection under the request's own transaction (a hang
-- at concurrency >= pool size) and bypasses RLS entirely (#2417 shipped a
-- cross-tenant hole through exactly that path).
--
-- The fix is a SELECT-only own-partner branch keyed on
-- `public.breeze_current_partner_id()` — the caller's OWN partner, from the
-- `breeze.current_partner_id` GUC that `buildDbAccessContext` populates for
-- EVERY scope including org tokens (and, since #4673 W02, agent sessions via
-- `middleware/agentAuth.ts`). The function already exists
-- (2026-06-13-catalog-partner-read-branch.sql); this file does NOT recreate it.
--
-- WHY A SEPARATE POLICY PER TABLE, NEVER AN EDIT TO THE EXISTING ONE
-- Each table below carries its own dual-axis isolation policy
-- (`<table>_isolation`, or the per-command `software_catalog_dual_isolation_*`
-- split). Appending `OR (org_id IS NULL AND partner_id = ...)` to a FOR ALL
-- `USING` would ALSO widen UPDATE/DELETE row targeting to partner-wide rows —
-- an org admin could then rewrite or delete their MSP's shared policy.
-- Postgres never consults FOR SELECT policies when computing UPDATE/DELETE
-- target rows, so a separate permissive FOR SELECT policy ORs into reads and
-- nothing else. The existing policies are left byte-identical; this file only
-- CREATEs new names.
--
-- software_catalog additionally keeps its narrower built-in-package branch from
-- 2026-07-02-builtin-catalog-partner-read-rls.sql (integration_provider IS NOT
-- NULL). Permissive policies OR, so the two coexist: that one covers an org
-- member reading its partner's Huntress/SentinelOne packages even when the GUC
-- is unset, this one covers every partner-wide catalog row for a caller whose
-- own partner is known.
--
-- SCOPE BEHAVIOUR
--   org scope     — GUC set to the token's own partner: branch fires for that
--                   partner's partner-wide rows only.
--   partner scope — already covered by `breeze_has_partner_access`; the branch
--                   is redundant but harmless (permissive policies OR).
--   system scope  — already short-circuited by every existing policy.
--   agent scope   — `middleware/agentAuth.ts` sets `currentPartnerId:
--                   device.partnerId` (#4673 W02), so agents DO get their own
--                   partner's partner-wide rows. That is intended: these five
--                   tables are agent-delivered policy (software allow/block
--                   lists, security settings, sensitive-data scan scope,
--                   peripheral control rules) and partner-wide rows are exactly
--                   the "apply to all my orgs" shape. The predicate uses `=`
--                   and not `IS NOT DISTINCT FROM`, so a NULL GUC (any context
--                   that does not populate it) still matches nothing.
--
-- Writes no rows, so it needs no `breeze.scope` elevation (see
-- src/db/migrationRlsScope.test.ts).
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE, so re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
--
-- Rollback: a new migration issuing the five matching
-- `DROP POLICY IF EXISTS <table>_partner_wide_select` statements. The policies
-- are purely additive and no application code depends on them in this change
-- (the escalation wrappers are removed in a later wave), so dropping them
-- restores exact pre-change behaviour.

DROP POLICY IF EXISTS software_catalog_partner_wide_select ON public.software_catalog;
CREATE POLICY software_catalog_partner_wide_select
  ON public.software_catalog
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS software_policies_partner_wide_select ON public.software_policies;
CREATE POLICY software_policies_partner_wide_select
  ON public.software_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS security_policies_partner_wide_select ON public.security_policies;
CREATE POLICY security_policies_partner_wide_select
  ON public.security_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS sensitive_data_policies_partner_wide_select ON public.sensitive_data_policies;
CREATE POLICY sensitive_data_policies_partner_wide_select
  ON public.sensitive_data_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS peripheral_policies_partner_wide_select ON public.peripheral_policies;
CREATE POLICY peripheral_policies_partner_wide_select
  ON public.peripheral_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
