-- Partner-wide READ branch on the notification rails + maintenance windows
-- (#4955, #4956, #4957, #4958 — the four follow-ups filed by wave 4 of #4673).
--
-- Same gap, same fix, same rationale as the template this file is copied from:
-- 2026-10-05-110000-config-policy-partner-wide-select.sql. Read its header for
-- the full argument; the short version is below.
--
-- PROBLEM
-- A partner-wide row here is `org_id NULL, partner_id = P`. An ORG-scoped
-- session cannot see it: `breeze_has_org_access(NULL)` is false, and
-- `breeze_has_partner_access(P)` is false because org scope carries an empty
-- `accessible_partner_ids` (that GUC governs partner-axis WRITES, and an org
-- token never holds it). Each of the four tables carries a SINGLE `FOR ALL`
-- policy (`<table>_isolation`, from 2026-07-01-maintenance-windows-partner-
-- ownership.sql / 2026-07-01-notification-rails-partner-ownership.sql) of the
-- form `system OR (org_id IS NOT NULL AND has_org_access) OR (partner_id IS
-- NOT NULL AND has_partner_access)`, so every request-path reader of a
-- partner-wide channel / routing rule / escalation policy / maintenance window
-- is blind and has to escalate through the #1105 pattern,
-- `runOutsideDbContext(() => withSystemDbAccessContext(...))`, which acquires a
-- SECOND pooled connection while the request's own transaction holds the first
-- (a hang at concurrency >= pool size) and bypasses RLS entirely (#2417 shipped
-- a cross-tenant hole through exactly that class).
--
-- FIX
-- A SELECT-only own-partner branch keyed on `public.breeze_current_partner_id()`
-- — the caller's OWN partner, read from the `breeze.current_partner_id` GUC,
-- which `buildDbAccessContext` populates for EVERY scope including org tokens.
-- Helper shipped in 2026-06-13-catalog-partner-read-branch.sql; NOT recreated
-- here. All four tables carry `org_id` and `partner_id` directly on the row
-- with a `<table>_one_owner_chk` XOR CHECK, so all four take the direct-column
-- form — no EXISTS join needed.
--
-- WHY A SEPARATE POLICY PER TABLE, NEVER AN EDIT TO THE EXISTING ONE
-- Appending `OR (org_id IS NULL AND partner_id = ...)` to a FOR ALL `USING`
-- would ALSO widen UPDATE/DELETE row targeting to partner-wide rows — an org
-- admin could then rename or delete their MSP's shared Slack channel or
-- maintenance window. Postgres never consults FOR SELECT policies when
-- computing UPDATE/DELETE target rows, so a separate permissive FOR SELECT
-- policy ORs into reads and nothing else. The existing `*_isolation` policies
-- are left byte-identical.
--
-- SCOPE BEHAVIOUR
--   org scope     — GUC set to the token's own partner: branch fires for that
--                   partner's partner-wide rows only.
--   partner scope — already covered by `breeze_has_partner_access`; the branch
--                   is redundant but harmless (permissive policies OR).
--   system scope  — already short-circuited by every existing policy.
--   agent scope   — `middleware/agentAuth.ts` populates `currentPartnerId` from
--                   the device's partner (#4673 W02), so the branch is
--                   load-bearing there: it is what lets a partner-wide
--                   maintenance window or notification rail reach agents at
--                   all. A NULL GUC yields `partner_id = NULL`, which is NULL,
--                   never true — which is why the predicate uses `=` and not
--                   `IS NOT DISTINCT FROM` (that would match NULL-partner rows).
--
-- Functional proof: apps/api/src/__tests__/integration/
-- notificationMaintenancePartnerWideSelect.integration.test.ts (org session of
-- the owning partner reads both rows; a different partner's org session reads
-- neither; UPDATE/DELETE of the partner-wide row affect 0 rows; INSERT forge
-- raises 42501). Shape contract: rls-coverage.integration.test.ts, from whose
-- PARTNER_WIDE_SELECT_BRANCH_EXEMPT allowlist these four tables are removed by
-- this change.
--
-- Writes no rows, so no `breeze.scope` elevation is needed (DDL only, and
-- CREATE POLICY is not RLS-governed).
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE, so re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
--
-- Rollback: a new migration issuing the four matching
-- `DROP POLICY IF EXISTS <table>_partner_wide_select` statements. The policies
-- are purely additive; dropping them restores exact pre-change behaviour.

DROP POLICY IF EXISTS notification_channels_partner_wide_select ON public.notification_channels;
CREATE POLICY notification_channels_partner_wide_select
  ON public.notification_channels
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS notification_routing_rules_partner_wide_select ON public.notification_routing_rules;
CREATE POLICY notification_routing_rules_partner_wide_select
  ON public.notification_routing_rules
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS escalation_policies_partner_wide_select ON public.escalation_policies;
CREATE POLICY escalation_policies_partner_wide_select
  ON public.escalation_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS maintenance_windows_partner_wide_select ON public.maintenance_windows;
CREATE POLICY maintenance_windows_partner_wide_select
  ON public.maintenance_windows
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
