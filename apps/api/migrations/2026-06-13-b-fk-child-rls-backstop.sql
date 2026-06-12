-- 2026-06-13-b: RLS backstop for seven tenant CHILD tables keyed by a parent
-- FK (no org_id column), plus a tightening of the over-permissive
-- ticket_comments INSERT policy.
--
-- Root cause (security review): the RLS coverage contract test auto-discovers
-- tenant tables by the presence of an `org_id` column. Tenant child tables that
-- reach their tenant only through a parent FK (and carry no denormalized
-- org_id) are invisible to that auto-discovery and these seven shipped with NO
-- row-level security at all — violating the CLAUDE.md invariant "no
-- app-layer-only fallback". This migration installs ENABLE + FORCE RLS and
-- per-command parent-join policies on each, mirroring the canonical shape from
-- 2026-05-30-fk-child-tables-rls.sql. The companion change to
-- rls-coverage.integration.test.ts adds all seven to PARENT_FK_JOIN_POLICY_TABLES
-- so the class stops recurring.
--
-- Shape: a single FLAT EXISTS over the parent table, gated by
-- public.breeze_has_org_access(parent.org_id). FLAT (not nested / multi-branch)
-- deliberately — the repo hit a postgres.js bound-param bug with nested EXISTS
-- through a nullable-org parent (#1016/#1026); keeping each branch a single
-- flat EXISTS avoids it. System/background writers run under
-- withSystemDbAccessContext, where breeze_has_org_access short-circuits TRUE.
--
-- Special case: role_permissions' parent `roles` is DUAL-AXIS (org_id and
-- partner_id both nullable) with system-role templates (is_system = true,
-- both axes NULL). Its policy mirrors 2026-04-11-roles-rls-fix.sql's access
-- predicate so partner-owned and system roles stay reachable:
--   breeze_has_partner_access(r.partner_id) OR breeze_has_org_access(r.org_id)
--   OR (is_system AND both axes NULL AND a real scope).
--
-- Idempotent: DROP POLICY IF EXISTS x4 before each CREATE; ENABLE/FORCE are
-- no-ops when already set. Re-running converges to the same state.
-- autoMigrate wraps each migration file in a transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- webhook_deliveries  ->  webhooks(webhook_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON webhook_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON webhook_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON webhook_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON webhook_deliveries;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON webhook_deliveries FOR SELECT USING (
  EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id AND public.breeze_has_org_access(w.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON webhook_deliveries FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id AND public.breeze_has_org_access(w.org_id))
);
CREATE POLICY breeze_org_isolation_update ON webhook_deliveries FOR UPDATE USING (
  EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id AND public.breeze_has_org_access(w.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id AND public.breeze_has_org_access(w.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON webhook_deliveries FOR DELETE USING (
  EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id AND public.breeze_has_org_access(w.org_id))
);

-- ---------------------------------------------------------------------------
-- network_monitor_alert_rules  ->  network_monitors(monitor_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON network_monitor_alert_rules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_monitor_alert_rules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_monitor_alert_rules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_monitor_alert_rules;
ALTER TABLE network_monitor_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_monitor_alert_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON network_monitor_alert_rules FOR SELECT USING (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_alert_rules.monitor_id AND public.breeze_has_org_access(m.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON network_monitor_alert_rules FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_alert_rules.monitor_id AND public.breeze_has_org_access(m.org_id))
);
CREATE POLICY breeze_org_isolation_update ON network_monitor_alert_rules FOR UPDATE USING (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_alert_rules.monitor_id AND public.breeze_has_org_access(m.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_alert_rules.monitor_id AND public.breeze_has_org_access(m.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON network_monitor_alert_rules FOR DELETE USING (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_alert_rules.monitor_id AND public.breeze_has_org_access(m.org_id))
);

-- ---------------------------------------------------------------------------
-- network_monitor_results  ->  network_monitors(monitor_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON network_monitor_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_monitor_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_monitor_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_monitor_results;
ALTER TABLE network_monitor_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_monitor_results FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON network_monitor_results FOR SELECT USING (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_results.monitor_id AND public.breeze_has_org_access(m.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON network_monitor_results FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_results.monitor_id AND public.breeze_has_org_access(m.org_id))
);
CREATE POLICY breeze_org_isolation_update ON network_monitor_results FOR UPDATE USING (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_results.monitor_id AND public.breeze_has_org_access(m.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_results.monitor_id AND public.breeze_has_org_access(m.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON network_monitor_results FOR DELETE USING (
  EXISTS (SELECT 1 FROM network_monitors m WHERE m.id = network_monitor_results.monitor_id AND public.breeze_has_org_access(m.org_id))
);

-- ---------------------------------------------------------------------------
-- role_permissions  ->  roles(role_id)   [dual-axis parent + system-role carve-out]
-- ---------------------------------------------------------------------------
-- `roles` is dual-axis (org_id/partner_id both nullable) with global system
-- templates. Mirror 2026-04-11-roles-rls-fix.sql's predicate so partner-owned
-- and system roles stay reachable. The flat EXISTS keeps the #1016 bound-param
-- bug at bay. breeze_has_org_access is present (required by the contract test);
-- breeze_has_partner_access + the is_system carve-out widen access correctly.
DROP POLICY IF EXISTS breeze_org_isolation_select ON role_permissions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON role_permissions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON role_permissions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON role_permissions;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON role_permissions FOR SELECT USING (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (
    public.breeze_has_partner_access(r.partner_id)
    OR public.breeze_has_org_access(r.org_id)
    OR (r.is_system = true AND r.partner_id IS NULL AND r.org_id IS NULL
        AND public.breeze_current_scope() IS NOT NULL
        AND public.breeze_current_scope() <> 'none')))
);
CREATE POLICY breeze_org_isolation_insert ON role_permissions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (
    public.breeze_has_partner_access(r.partner_id)
    OR public.breeze_has_org_access(r.org_id)))
);
CREATE POLICY breeze_org_isolation_update ON role_permissions FOR UPDATE USING (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (
    public.breeze_has_partner_access(r.partner_id)
    OR public.breeze_has_org_access(r.org_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (
    public.breeze_has_partner_access(r.partner_id)
    OR public.breeze_has_org_access(r.org_id)))
);
CREATE POLICY breeze_org_isolation_delete ON role_permissions FOR DELETE USING (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (
    public.breeze_has_partner_access(r.partner_id)
    OR public.breeze_has_org_access(r.org_id)))
);

-- ---------------------------------------------------------------------------
-- plugin_logs  ->  plugin_installations(installation_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON plugin_logs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON plugin_logs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON plugin_logs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON plugin_logs;
ALTER TABLE plugin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON plugin_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM plugin_installations pi WHERE pi.id = plugin_logs.installation_id AND public.breeze_has_org_access(pi.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON plugin_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM plugin_installations pi WHERE pi.id = plugin_logs.installation_id AND public.breeze_has_org_access(pi.org_id))
);
CREATE POLICY breeze_org_isolation_update ON plugin_logs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM plugin_installations pi WHERE pi.id = plugin_logs.installation_id AND public.breeze_has_org_access(pi.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM plugin_installations pi WHERE pi.id = plugin_logs.installation_id AND public.breeze_has_org_access(pi.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON plugin_logs FOR DELETE USING (
  EXISTS (SELECT 1 FROM plugin_installations pi WHERE pi.id = plugin_logs.installation_id AND public.breeze_has_org_access(pi.org_id))
);

-- ---------------------------------------------------------------------------
-- report_runs  ->  reports(report_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON report_runs;
ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON report_runs FOR SELECT USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON report_runs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_update ON report_runs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id AND public.breeze_has_org_access(r.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON report_runs FOR DELETE USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id AND public.breeze_has_org_access(r.org_id))
);

-- ---------------------------------------------------------------------------
-- maintenance_occurrences  ->  maintenance_windows(window_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON maintenance_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON maintenance_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_update ON maintenance_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON maintenance_occurrences;
ALTER TABLE maintenance_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON maintenance_occurrences FOR SELECT USING (
  EXISTS (SELECT 1 FROM maintenance_windows mw WHERE mw.id = maintenance_occurrences.window_id AND public.breeze_has_org_access(mw.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON maintenance_occurrences FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM maintenance_windows mw WHERE mw.id = maintenance_occurrences.window_id AND public.breeze_has_org_access(mw.org_id))
);
CREATE POLICY breeze_org_isolation_update ON maintenance_occurrences FOR UPDATE USING (
  EXISTS (SELECT 1 FROM maintenance_windows mw WHERE mw.id = maintenance_occurrences.window_id AND public.breeze_has_org_access(mw.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM maintenance_windows mw WHERE mw.id = maintenance_occurrences.window_id AND public.breeze_has_org_access(mw.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON maintenance_occurrences FOR DELETE USING (
  EXISTS (SELECT 1 FROM maintenance_windows mw WHERE mw.id = maintenance_occurrences.window_id AND public.breeze_has_org_access(mw.org_id))
);

-- ---------------------------------------------------------------------------
-- ticket_comments INSERT tightening
-- ---------------------------------------------------------------------------
-- The Phase 6 user-scoped INSERT policy (breeze_user_isolation_insert,
-- 2026-04-11-bucket-c-phase-6-user-scoped-rls.sql) authorized ANY row where
-- user_id = breeze_current_user_id() with NO parent-ticket org check, letting a
-- user post a comment onto a ticket in any org. Recreate it so the WITH CHECK
-- also requires the parent ticket to be org-accessible. tickets.org_id is NOT
-- NULL and the tickets policy has no OR branches, so the EXISTS join is
-- #1016-safe. The NULL-user system carve-out and the partner/org-admin EXISTS
-- branch from the original are preserved (each still gated by the parent ticket
-- being org-accessible).
DROP POLICY IF EXISTS breeze_user_isolation_insert ON ticket_comments;
CREATE POLICY breeze_user_isolation_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id AND public.breeze_has_org_access(t.org_id))
    AND (
      (user_id IS NULL AND public.breeze_current_scope() = 'system')
      OR user_id = public.breeze_current_user_id()
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
                 AND (public.breeze_has_partner_access(u.partner_id)
                      OR public.breeze_has_org_access(u.org_id)))
    )
  );
