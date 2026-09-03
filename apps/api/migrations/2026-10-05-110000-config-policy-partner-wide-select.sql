-- Partner-wide READ branch on the configuration-policy chain (#2468, wave 1 of #4673).
--
-- PROBLEM
-- A partner-wide config row is `org_id NULL, partner_id = P`. An ORG-scoped
-- session cannot see it: `breeze_has_org_access(NULL)` is false, and
-- `breeze_has_partner_access(P)` is false because org scope carries an empty
-- `accessible_partner_ids` (that GUC governs partner-axis WRITES, and an org
-- token never holds it). Every request-path reader of a partner-linkable
-- feature is therefore blind to partner-wide state and has to escalate through
-- the #1105 pattern, `runOutsideDbContext(() => withSystemDbAccessContext(...))`,
-- which:
--   1. acquires a SECOND pooled connection while the request's own
--      `withDbAccessContext` transaction still holds the first. postgres-js
--      queues acquisitions with no timeout, so at concurrency >= pool size
--      (~25 on the hosted DBs) that is a hang, not just contention; and
--   2. bypasses RLS entirely, so every escalated query must self-tenant or it
--      becomes a cross-tenant hole (#2417 shipped exactly that class in an
--      adjacent path).
--
-- FIX
-- A SELECT-only own-partner branch keyed on `public.breeze_current_partner_id()`
-- — the caller's OWN partner, read from the `breeze.current_partner_id` GUC,
-- which `buildDbAccessContext` populates for EVERY scope including org tokens.
-- No extra connection, no RLS bypass, and writes are untouched.
--
-- Precedent, twice shipped: 2026-06-13-catalog-partner-read-branch.sql (which
-- also created `breeze_current_partner_id()` — this migration does NOT recreate
-- it) and `cis_baselines_partner_wide_select` in
-- 2026-08-10-cis-baselines-partner-ownership.sql.
--
-- WHY A SEPARATE POLICY PER TABLE, NEVER AN EDIT TO THE EXISTING ONE
-- Every table below carries either a single FOR ALL policy or a per-command
-- split. Appending `OR (org_id IS NULL AND partner_id = ...)` to a FOR ALL
-- `USING` would ALSO widen UPDATE/DELETE row targeting to partner-wide rows —
-- an org admin could then delete their MSP's shared policy. Postgres never
-- consults FOR SELECT policies when computing UPDATE/DELETE target rows, so a
-- separate permissive FOR SELECT policy ORs into reads and nothing else. The
-- existing policies are left byte-identical; this file only CREATEs new names,
-- which also makes it immune to the policy-name drift several of these tables
-- have accumulated across migrations.
--
-- SCOPE BEHAVIOUR
--   org scope     — GUC set to the token's own partner: branch fires for that
--                   partner's partner-wide rows only.
--   partner scope — already covered by `breeze_has_partner_access`; the branch
--                   is redundant but harmless (permissive policies OR).
--   system scope  — already short-circuited by every existing policy.
--   agent scope   — `middleware/agentAuth.ts` sets `currentPartnerId: null`, so
--                   `breeze_current_partner_id()` is NULL and `partner_id = NULL`
--                   is NULL, never true. Agents are deliberately UNCHANGED by
--                   this migration; wave 2 populates that GUC on purpose.
--                   (This is why the predicate uses `=` and not
--                   `IS NOT DISTINCT FROM`, which would match NULL-partner rows.)
--
-- NOT INCLUDED: config_policy_onedrive_settings. It carries `org_id NOT NULL`
-- and `breeze_validate_config_policy_onedrive_settings`
-- (2026-07-27-b-onedrive-reference-ownership.sql) RAISEs when the parent policy
-- has `partner_id IS NOT NULL`. A partner-wide OneDrive settings row is not
-- representable, so a branch there would be unreachable code.
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE, so re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
--
-- Rollback: a new migration issuing the 15 matching
-- `DROP POLICY IF EXISTS <table>_partner_wide_select` statements. The policies
-- are purely additive and no application code depends on them yet (the
-- escalation wrappers are removed in wave 3), so dropping them restores exact
-- pre-wave behaviour.

-- ============================================
-- 1. Direct-column owners (org_id XOR partner_id on the row itself)
-- ============================================

DROP POLICY IF EXISTS configuration_policies_partner_wide_select ON public.configuration_policies;
CREATE POLICY configuration_policies_partner_wide_select
  ON public.configuration_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- config_policy_backup_settings denormalizes the parent's ownership axis onto
-- the row (2026-07-13-backup-profiles.sql) rather than reaching it by join, so
-- it takes the direct-column form too.
DROP POLICY IF EXISTS config_policy_backup_settings_partner_wide_select ON public.config_policy_backup_settings;
CREATE POLICY config_policy_backup_settings_partner_wide_select
  ON public.config_policy_backup_settings
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS backup_profiles_partner_wide_select ON public.backup_profiles;
CREATE POLICY backup_profiles_partner_wide_select
  ON public.backup_profiles
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- ============================================
-- 2. Direct children of configuration_policies (one hop: config_policy_id)
-- ============================================
-- Join shape mirrors each table's existing isolation policy so the planner
-- sees the same access path.

DROP POLICY IF EXISTS config_policy_feature_links_partner_wide_select ON public.config_policy_feature_links;
CREATE POLICY config_policy_feature_links_partner_wide_select
  ON public.config_policy_feature_links
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = config_policy_feature_links.config_policy_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_assignments_partner_wide_select ON public.config_policy_assignments;
CREATE POLICY config_policy_assignments_partner_wide_select
  ON public.config_policy_assignments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = config_policy_assignments.config_policy_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

-- ============================================
-- 3. Per-feature children (two hops: feature_link_id -> config_policy_id)
-- ============================================
-- These six use the JOIN form, matching their existing *_org_isolation policies
-- from 2026-06-27-config-policies-partner-ownership.sql.

DROP POLICY IF EXISTS config_policy_alert_rules_partner_wide_select ON public.config_policy_alert_rules;
CREATE POLICY config_policy_alert_rules_partner_wide_select
  ON public.config_policy_alert_rules
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.config_policy_feature_links fl
      JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_alert_rules.feature_link_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_automations_partner_wide_select ON public.config_policy_automations;
CREATE POLICY config_policy_automations_partner_wide_select
  ON public.config_policy_automations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.config_policy_feature_links fl
      JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_automations.feature_link_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_compliance_rules_partner_wide_select ON public.config_policy_compliance_rules;
CREATE POLICY config_policy_compliance_rules_partner_wide_select
  ON public.config_policy_compliance_rules
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.config_policy_feature_links fl
      JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_compliance_rules.feature_link_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_patch_settings_partner_wide_select ON public.config_policy_patch_settings;
CREATE POLICY config_policy_patch_settings_partner_wide_select
  ON public.config_policy_patch_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.config_policy_feature_links fl
      JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_patch_settings.feature_link_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_maintenance_settings_partner_wide_select ON public.config_policy_maintenance_settings;
CREATE POLICY config_policy_maintenance_settings_partner_wide_select
  ON public.config_policy_maintenance_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.config_policy_feature_links fl
      JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_maintenance_settings.feature_link_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_event_log_settings_partner_wide_select ON public.config_policy_event_log_settings;
CREATE POLICY config_policy_event_log_settings_partner_wide_select
  ON public.config_policy_event_log_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.config_policy_feature_links fl
      JOIN public.configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_event_log_settings.feature_link_id
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

-- ============================================
-- 4. Per-command-split children (scalar-subquery chain form)
-- ============================================
-- sensitive_data / monitoring / remote_access keep the single-table
-- `FROM configuration_policies` + scalar-subquery hop shape their existing
-- policies use (2026-06-23-sec-review-1, 2026-06-27, 2026-07-29): it is
-- #1016-safe, and the rls-coverage PARENT_FK_JOIN_POLICY_TABLES contract keys
-- on exactly that shape.

DROP POLICY IF EXISTS config_policy_sensitive_data_settings_partner_wide_select ON public.config_policy_sensitive_data_settings;
CREATE POLICY config_policy_sensitive_data_settings_partner_wide_select
  ON public.config_policy_sensitive_data_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM public.config_policy_feature_links fl
                      WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_monitoring_settings_partner_wide_select ON public.config_policy_monitoring_settings;
CREATE POLICY config_policy_monitoring_settings_partner_wide_select
  ON public.config_policy_monitoring_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM public.config_policy_feature_links fl
                      WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

-- One extra hop: settings_id -> monitoring_settings -> feature_link -> policy.
DROP POLICY IF EXISTS config_policy_monitoring_watches_partner_wide_select ON public.config_policy_monitoring_watches;
CREATE POLICY config_policy_monitoring_watches_partner_wide_select
  ON public.config_policy_monitoring_watches
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM public.config_policy_feature_links fl
                      WHERE fl.id = (SELECT ms.feature_link_id
                                       FROM public.config_policy_monitoring_settings ms
                                      WHERE ms.id = config_policy_monitoring_watches.settings_id))
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );

DROP POLICY IF EXISTS config_policy_remote_access_settings_partner_wide_select ON public.config_policy_remote_access_settings;
CREATE POLICY config_policy_remote_access_settings_partner_wide_select
  ON public.config_policy_remote_access_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM public.config_policy_feature_links fl
                      WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
        AND cp.org_id IS NULL
        AND cp.partner_id = public.breeze_current_partner_id()
    )
  );
