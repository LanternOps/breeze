-- Partner-wide READ branch on the automation + alert-rule config tables
-- (#4952 automations, #4950 automation_policies, #4951
-- automation_resource_bindings, #4949 alert_rules) — the next group of the
-- SELECT-only own-partner branch shipped for the configuration-policy chain in
-- 2026-10-05-110000-config-policy-partner-wide-select.sql (wave 1 of #4673).
-- Read that file's header for the full rationale; the short version:
--
-- A partner-wide row is `org_id NULL, partner_id = P`. An ORG-scoped session
-- cannot see it — `breeze_has_org_access(NULL)` is false and
-- `breeze_has_partner_access(P)` is false because org scope carries an empty
-- `accessible_partner_ids` — so every request-path reader has to escalate
-- through the #1105 pattern (`runOutsideDbContext(() =>
-- withSystemDbAccessContext(...))`), which acquires a SECOND pooled connection
-- while the request's own transaction holds the first and bypasses RLS
-- entirely. `breeze_current_partner_id()` (created by
-- 2026-06-13-catalog-partner-read-branch.sql, NOT recreated here) reads the
-- caller's OWN partner from a GUC that `buildDbAccessContext` populates for
-- every scope, so the branch needs no extra connection and no RLS bypass.
--
-- A SEPARATE FOR SELECT policy per table, never an edit to the existing one:
-- all four carry a single dual-axis FOR ALL policy (`automations_isolation`,
-- `automation_policies_isolation`, `automation_resource_bindings_isolation`,
-- `alert_rules_isolation`), and appending this branch to a FOR ALL `USING`
-- would also widen UPDATE/DELETE row targeting — an org admin could then
-- rewrite or delete their MSP's shared automation. Postgres never consults a
-- FOR SELECT policy when computing UPDATE/DELETE target rows, so a separate
-- permissive policy ORs into reads and nothing else. The existing policies are
-- left byte-identical.
--
-- All four tables carry `org_id` and `partner_id` directly on the row with an
-- XOR CHECK (`automations_one_owner_chk`, `automation_policies_one_owner_chk`,
-- `automation_resource_bindings_one_owner_chk`, `alert_rules_one_owner_chk`),
-- so all four take the direct-column form — no EXISTS join to a parent.
-- automation_resource_bindings copies its parent automation's owner axes
-- (2026-09-25-a), which is why the direct form is correct there too.
--
-- The branch is LOAD-BEARING on the agent path. `middleware/agentAuth.ts`
-- sets `currentPartnerId: device.partnerId` (#4673 W02), so an agent session
-- gains exactly this read: `buildPolicyProbeConfigUpdate`
-- (routes/agents/helpers.ts) already asks for partner-wide automation_policies
-- with an app-layer `org_id IS NULL AND partner_id = <org's partner>` branch on
-- the heartbeat path, and before this migration RLS silently returned zero rows
-- for it — the agent never collected registry/config probes for partner-wide
-- compliance policies, with no error anywhere.
--
-- The predicate uses `=` and not `IS NOT DISTINCT FROM`: a context that leaves
-- the GUC unset reads NULL, and `partner_id = NULL` is NULL, never true. Under
-- `IS NOT DISTINCT FROM` every such session would see EVERY partner's shared
-- rows.
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE, so re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction. This
-- migration writes no rows, so it needs no `breeze.scope` elevation.
--
-- Rollback: a new migration issuing the four matching
-- `DROP POLICY IF EXISTS <table>_partner_wide_select` statements. The policies
-- are purely additive; no reader code is changed here.

DROP POLICY IF EXISTS automations_partner_wide_select ON public.automations;
CREATE POLICY automations_partner_wide_select
  ON public.automations
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS automation_policies_partner_wide_select ON public.automation_policies;
CREATE POLICY automation_policies_partner_wide_select
  ON public.automation_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS automation_resource_bindings_partner_wide_select ON public.automation_resource_bindings;
CREATE POLICY automation_resource_bindings_partner_wide_select
  ON public.automation_resource_bindings
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS alert_rules_partner_wide_select ON public.alert_rules;
CREATE POLICY alert_rules_partner_wide_select
  ON public.alert_rules
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
