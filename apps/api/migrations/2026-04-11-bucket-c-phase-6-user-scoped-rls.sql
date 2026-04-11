-- 2026-04-11: Bucket C Phase 6 — user-id-scoped cluster RLS.
--
-- Tables in this phase are keyed on `user_id` rather than `device_id`.
-- Each row belongs to a single user, and visibility follows the user's
-- tenancy: the user themselves, plus admins with access to the user's
-- partner/org, plus system scope.
--
-- Tables:
--   - user_sso_identities  (SSO provider linkages; tokens encrypted at rest)
--   - push_notifications   (per-user notification records)
--   - mobile_devices       (mobile app device registrations — user_id is
--                           the owner; mobile_devices.device_id is a platform
--                           id, NOT an FK to `devices`)
--   - ticket_comments      (support ticket comments — user_id may be
--                           null for portal-user authored rows)
--   - access_review_items  (access review entries — user_id is the
--                           subject of the review)
--
-- Deferred to a later PR:
--   - sessions       (user auth sessions; written pre-auth at login time,
--                     requires either `withSystemDbAccessContext` wrapping
--                     at session creation or a permissive INSERT policy)
--   - mobile_sessions (no writers found in the codebase — likely dead)
--
-- Policy shape:
--   USING (
--     user_id = public.breeze_current_user_id()
--     OR EXISTS (
--       SELECT 1 FROM users u
--        WHERE u.id = <table>.user_id
--          AND (
--            public.breeze_has_partner_access(u.partner_id)
--            OR public.breeze_has_org_access(u.org_id)
--          )
--     )
--   )
--
-- System scope is handled inside the helper functions (short-circuit to
-- TRUE), so no explicit system branch is needed. The EXISTS subquery
-- itself also has to pass the `users` RLS policy — and that policy
-- grants visibility on the same conditions (partner_access OR org_access
-- OR self), so the whole thing composes correctly.
--
-- For ticket_comments specifically, the `user_id` can be NULL (portal-
-- user-authored rows). The `user_id = breeze_current_user_id()` branch
-- evaluates to NULL rather than TRUE when both are null, and the
-- EXISTS branch would match nothing. So portal-user-authored comments
-- would become invisible to everyone except system scope. We add an
-- explicit `user_id IS NULL AND breeze_current_scope() = 'system'`
-- carve-out so system paths can still read/write those rows. (A fuller
-- fix would route portal-user visibility through the portal_user_id
-- axis; deferred.)
--
-- Fully idempotent.

BEGIN;

-- -------- user_sso_identities --------
DROP POLICY IF EXISTS breeze_user_isolation_select ON user_sso_identities;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON user_sso_identities;
DROP POLICY IF EXISTS breeze_user_isolation_update ON user_sso_identities;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON user_sso_identities;
ALTER TABLE user_sso_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sso_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_user_isolation_select ON user_sso_identities
  FOR SELECT USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_sso_identities.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_insert ON user_sso_identities
  FOR INSERT WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_sso_identities.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_update ON user_sso_identities
  FOR UPDATE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_sso_identities.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  )
  WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_sso_identities.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_delete ON user_sso_identities
  FOR DELETE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_sso_identities.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );

-- -------- push_notifications --------
DROP POLICY IF EXISTS breeze_user_isolation_select ON push_notifications;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON push_notifications;
DROP POLICY IF EXISTS breeze_user_isolation_update ON push_notifications;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON push_notifications;
ALTER TABLE push_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_user_isolation_select ON push_notifications
  FOR SELECT USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_insert ON push_notifications
  FOR INSERT WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_update ON push_notifications
  FOR UPDATE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  )
  WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_delete ON push_notifications
  FOR DELETE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = push_notifications.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );

-- -------- mobile_devices --------
DROP POLICY IF EXISTS breeze_user_isolation_select ON mobile_devices;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON mobile_devices;
DROP POLICY IF EXISTS breeze_user_isolation_update ON mobile_devices;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON mobile_devices;
ALTER TABLE mobile_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_user_isolation_select ON mobile_devices
  FOR SELECT USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = mobile_devices.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_insert ON mobile_devices
  FOR INSERT WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = mobile_devices.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_update ON mobile_devices
  FOR UPDATE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = mobile_devices.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  )
  WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = mobile_devices.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_delete ON mobile_devices
  FOR DELETE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = mobile_devices.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );

-- -------- ticket_comments --------
-- Adds a system-scope carve-out for NULL user_id (portal-user-authored).
DROP POLICY IF EXISTS breeze_user_isolation_select ON ticket_comments;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON ticket_comments;
DROP POLICY IF EXISTS breeze_user_isolation_update ON ticket_comments;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON ticket_comments;
ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_user_isolation_select ON ticket_comments
  FOR SELECT USING (
    (user_id IS NULL AND public.breeze_current_scope() = 'system')
    OR user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    (user_id IS NULL AND public.breeze_current_scope() = 'system')
    OR user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_update ON ticket_comments
  FOR UPDATE USING (
    (user_id IS NULL AND public.breeze_current_scope() = 'system')
    OR user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  )
  WITH CHECK (
    (user_id IS NULL AND public.breeze_current_scope() = 'system')
    OR user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_delete ON ticket_comments
  FOR DELETE USING (
    (user_id IS NULL AND public.breeze_current_scope() = 'system')
    OR user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );

-- -------- access_review_items --------
DROP POLICY IF EXISTS breeze_user_isolation_select ON access_review_items;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON access_review_items;
DROP POLICY IF EXISTS breeze_user_isolation_update ON access_review_items;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON access_review_items;
ALTER TABLE access_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_user_isolation_select ON access_review_items
  FOR SELECT USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = access_review_items.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_insert ON access_review_items
  FOR INSERT WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = access_review_items.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_update ON access_review_items
  FOR UPDATE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = access_review_items.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  )
  WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = access_review_items.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );
CREATE POLICY breeze_user_isolation_delete ON access_review_items
  FOR DELETE USING (
    user_id = public.breeze_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = access_review_items.user_id
               AND (public.breeze_has_partner_access(u.partner_id)
                    OR public.breeze_has_org_access(u.org_id)))
  );

COMMIT;
