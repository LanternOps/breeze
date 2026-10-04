-- push_notifications: the recipient keeps their own rows; anyone else also
-- needs access to the organization of the alert the notification is for.
--
-- push_notifications has no org_id column. A row copies the alert's title,
-- body and data, so its tenancy for non-recipients is the alert's org
-- (alert_id -> alerts.org_id). The Phase 6 policies
-- (2026-04-11-bucket-c-phase-6-user-scoped-rls.sql) let any user with
-- partner-level access to the recipient reach the row, which ignores the
-- technician's selected-org list.
--
-- New predicate, applied to every command (USING and WITH CHECK):
--   * system scope (the notification writer), or
--   * the recipient (user_id = current user), or
--   * the alert exists and its org is accessible, AND the original
--     recipient-user predicate holds.
-- Rows with no alert_id, or whose alert no longer exists (alert_id has no FK),
-- are visible to the recipient and system scope only.
--
-- #1016/#1026 bound-param safety: alerts.org_id is NOT NULL and the alerts
-- policies have no OR branches, so the flat EXISTS join is safe under
-- postgres.js bound parameters (pushNotificationsAlertOrgRls.integration.test.ts
-- runs through the real driver).
--
-- No data is written. Idempotent: DROP POLICY IF EXISTS before each CREATE.

ALTER TABLE push_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_user_isolation_select ON push_notifications;
CREATE POLICY breeze_user_isolation_select ON push_notifications
  FOR SELECT USING (
    public.breeze_current_scope() = 'system'
    OR user_id = public.breeze_current_user_id()
    OR (
      EXISTS (SELECT 1 FROM alerts a WHERE a.id = push_notifications.alert_id
              AND public.breeze_has_org_access(a.org_id))
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
                  AND (public.breeze_has_partner_access(u.partner_id)
                       OR public.breeze_has_org_access(u.org_id)))
    )
  );

DROP POLICY IF EXISTS breeze_user_isolation_insert ON push_notifications;
CREATE POLICY breeze_user_isolation_insert ON push_notifications
  FOR INSERT WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR user_id = public.breeze_current_user_id()
    OR (
      EXISTS (SELECT 1 FROM alerts a WHERE a.id = push_notifications.alert_id
              AND public.breeze_has_org_access(a.org_id))
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
                  AND (public.breeze_has_partner_access(u.partner_id)
                       OR public.breeze_has_org_access(u.org_id)))
    )
  );

DROP POLICY IF EXISTS breeze_user_isolation_update ON push_notifications;
CREATE POLICY breeze_user_isolation_update ON push_notifications
  FOR UPDATE USING (
    public.breeze_current_scope() = 'system'
    OR user_id = public.breeze_current_user_id()
    OR (
      EXISTS (SELECT 1 FROM alerts a WHERE a.id = push_notifications.alert_id
              AND public.breeze_has_org_access(a.org_id))
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
                  AND (public.breeze_has_partner_access(u.partner_id)
                       OR public.breeze_has_org_access(u.org_id)))
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR user_id = public.breeze_current_user_id()
    OR (
      EXISTS (SELECT 1 FROM alerts a WHERE a.id = push_notifications.alert_id
              AND public.breeze_has_org_access(a.org_id))
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
                  AND (public.breeze_has_partner_access(u.partner_id)
                       OR public.breeze_has_org_access(u.org_id)))
    )
  );

DROP POLICY IF EXISTS breeze_user_isolation_delete ON push_notifications;
CREATE POLICY breeze_user_isolation_delete ON push_notifications
  FOR DELETE USING (
    public.breeze_current_scope() = 'system'
    OR user_id = public.breeze_current_user_id()
    OR (
      EXISTS (SELECT 1 FROM alerts a WHERE a.id = push_notifications.alert_id
              AND public.breeze_has_org_access(a.org_id))
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
                  AND (public.breeze_has_partner_access(u.partner_id)
                       OR public.breeze_has_org_access(u.org_id)))
    )
  );
