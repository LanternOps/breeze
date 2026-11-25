-- @no-transaction
-- group_membership_log: index the (group_id, device_id) lookup (#12666).
--
-- The fleet-step group gate (#12418 W02) joins a static group's memberships to
-- this log on (group_id, device_id). The table had only its primary key, so the
-- read scanned the whole log, every organisation's rows included, and on a
-- large log it could exceed the 500 ms filter query time limit, which refuses
-- every fleet step that reaches a static group.
--
-- Two key columns only. group_id and device_id are uuid equalities, which are
-- leakproof, so they stay index conditions under the RLS security qual as
-- breeze_app. reason is an enum (not leakproof), so it stays a filter; org_id
-- adds nothing, because a group_id already belongs to one org. On a seeded 5M-row log,
-- adding created_at or INCLUDE (org_id, reason) measured no faster and made
-- the index about 8 and 11 times larger, because the extra columns defeat
-- btree deduplication of repeated (group_id, device_id) keys.
--
-- CREATE INDEX CONCURRENTLY: dynamic re-evaluation, pin/unpin and the
-- enrollment default-group add insert into this log, and a plain CREATE INDEX
-- would block those inserts for the whole build. IF NOT EXISTS keeps re-application a no-op, so
-- an index built by hand before deploy is accepted as is. No lock_timeout: a
-- concurrent build waits for older transactions without blocking writers, and
-- cutting that wait short would leave an INVALID index.
--
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY group_membership_log_group_device_idx,
-- then let autoMigrate re-run this file.
--
-- No row is written, so no system-scope election is needed. No tenancy change:
-- no new table or column.

CREATE INDEX CONCURRENTLY IF NOT EXISTS group_membership_log_group_device_idx
  ON public.group_membership_log (group_id, device_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.group_membership_log'::regclass
       AND c.relname = 'group_membership_log_group_device_idx'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'group_membership_log_group_device_idx build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
