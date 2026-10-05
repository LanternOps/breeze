-- Org erasure: give FK-only child tables an ON DELETE action.
--
-- None of these tables has an org_id of its own, so cascadeDeleteOrg()
-- (services/tenantCascade.ts) never deletes from them directly. Each one holds
-- a foreign key, declared without an ON DELETE action (so NO ACTION), into a
-- table the erasure walk DOES delete from:
--
--   script_to_tags.script_id        -> scripts
--   script_to_tags.tag_id           -> script_tags
--   mobile_devices.user_id          -> users
--   push_notifications.user_id      -> users
--   mobile_sessions.user_id         -> users
--   partner_users.user_id           -> users
--
-- so the first row in any of them made org erasure abort with 23503 part-way
-- through the walk, leaving the tenant half-erased. They were carried as
-- accepted debt in ORG_CASCADE_FK_UNSAFE
-- (src/__tests__/integration/orgCascadeFkOnDeleteAllowlist.ts); this migration
-- retires those entries.
--
-- CASCADE in every case, because every child row is meaningless without its
-- parent: a script/tag link with either end gone, a mobile registration,
-- refresh session or push record for a user who no longer exists, a partner
-- membership for a deleted identity. Users whose partner membership still
-- grants access without the erased org are not deleted by org erasure at all
-- -- they are detached to partner-level staff first
-- (detachSharedIdentitiesFromOrg in tenantCascade.ts) -- so the partner_users
-- CASCADE only fires for an identity that is really being removed.
--
-- push_notifications.mobile_device_id and mobile_sessions.mobile_device_id
-- move to CASCADE as well: once mobile_devices rows can be removed by a
-- cascading delete, their own NO ACTION children would otherwise abort it
-- (they also made DELETE /mobile/devices/:id fail for any device that had
-- ever received a notification or opened a session).
--
-- Referential actions run with row security disabled, so these cascades fire
-- regardless of the children's RLS policies. No row is written here.
--
-- device_software.device_id -> devices gets the same treatment in the next
-- migration, which runs outside a transaction because device_software is a
-- large, hot table; the remaining child edges are in 2026-12-12-160200.
--
-- Locking. These child tables are small, so each FK is re-added validating,
-- inside autoMigrate's per-file transaction. That holds SHARE ROW EXCLUSIVE on
-- users, scripts and script_tags (and ACCESS EXCLUSIVE on each child) until
-- the file commits, and a lock request queued behind a long-running
-- transaction blocks every later writer on that table, so wait at most a few
-- seconds for each lock rather than stall logins and heartbeats; the file is
-- idempotent and safe to retry. SET LOCAL covers every statement below.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  ALTER TABLE public.script_to_tags
    DROP CONSTRAINT IF EXISTS script_to_tags_script_id_scripts_id_fk;
  ALTER TABLE public.script_to_tags
    ADD CONSTRAINT script_to_tags_script_id_scripts_id_fk
    FOREIGN KEY (script_id) REFERENCES public.scripts(id) ON DELETE CASCADE;

  ALTER TABLE public.script_to_tags
    DROP CONSTRAINT IF EXISTS script_to_tags_tag_id_script_tags_id_fk;
  ALTER TABLE public.script_to_tags
    ADD CONSTRAINT script_to_tags_tag_id_script_tags_id_fk
    FOREIGN KEY (tag_id) REFERENCES public.script_tags(id) ON DELETE CASCADE;

  ALTER TABLE public.mobile_devices
    DROP CONSTRAINT IF EXISTS mobile_devices_user_id_users_id_fk;
  ALTER TABLE public.mobile_devices
    ADD CONSTRAINT mobile_devices_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

  ALTER TABLE public.push_notifications
    DROP CONSTRAINT IF EXISTS push_notifications_user_id_users_id_fk;
  ALTER TABLE public.push_notifications
    ADD CONSTRAINT push_notifications_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

  ALTER TABLE public.push_notifications
    DROP CONSTRAINT IF EXISTS push_notifications_mobile_device_id_mobile_devices_id_fk;
  ALTER TABLE public.push_notifications
    ADD CONSTRAINT push_notifications_mobile_device_id_mobile_devices_id_fk
    FOREIGN KEY (mobile_device_id) REFERENCES public.mobile_devices(id) ON DELETE CASCADE;

  ALTER TABLE public.mobile_sessions
    DROP CONSTRAINT IF EXISTS mobile_sessions_user_id_users_id_fk;
  ALTER TABLE public.mobile_sessions
    ADD CONSTRAINT mobile_sessions_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

  ALTER TABLE public.mobile_sessions
    DROP CONSTRAINT IF EXISTS mobile_sessions_mobile_device_id_mobile_devices_id_fk;
  ALTER TABLE public.mobile_sessions
    ADD CONSTRAINT mobile_sessions_mobile_device_id_mobile_devices_id_fk
    FOREIGN KEY (mobile_device_id) REFERENCES public.mobile_devices(id) ON DELETE CASCADE;

  ALTER TABLE public.partner_users
    DROP CONSTRAINT IF EXISTS partner_users_user_id_users_id_fk;
  ALTER TABLE public.partner_users
    ADD CONSTRAINT partner_users_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
END $$;
