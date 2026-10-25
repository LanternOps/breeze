-- #8318 wave 1b-2 — the `reattached` holding-area exit (D4)
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.5).
--
-- A parked source that is reattached onto an existing record is retired in
-- place at confirm (decommissioned, never moved), and leaves the holding area
-- through a second explicit exit beside `assigned`. Both CHECKs of the
-- ledger (2026-11-08-190200) change:
--   * event_type_chk gains 'reattached';
--   * shape_chk gains a `reattached` arm: from_org_id is the holding org
--     (NOT NULL), to_org_id is the target's org (NOT NULL), an acting user
--     (assigned_by_user_id NOT NULL), parked_duration_seconds NOT NULL and
--     assignment_method NULL. The existing arms are unchanged.
--
-- The ledger is a low-volume, append-only table (holding-area events only),
-- not a hot one: one transactional file, DROP + ADD of each constraint (the
-- ADD validates the few existing rows under the table lock), bounded by
-- lock_timeout. Re-running is a no-op in effect (drop and re-add the same
-- definitions).
--
-- Writes no rows, so no system-scope election is needed.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.device_pool_assignment_events
  DROP CONSTRAINT IF EXISTS device_pool_assignment_events_event_type_chk;
ALTER TABLE public.device_pool_assignment_events
  ADD CONSTRAINT device_pool_assignment_events_event_type_chk
    CHECK (event_type IN ('enrolled', 'assigned', 'expired', 'purged', 'reattached'));

ALTER TABLE public.device_pool_assignment_events
  DROP CONSTRAINT IF EXISTS device_pool_assignment_events_shape_chk;
ALTER TABLE public.device_pool_assignment_events
  ADD CONSTRAINT device_pool_assignment_events_shape_chk CHECK (
    (event_type = 'enrolled'
       AND from_org_id IS NULL AND to_org_id IS NOT NULL
       AND assignment_method IS NULL AND parked_duration_seconds IS NULL)
    OR (event_type = 'assigned'
       AND from_org_id IS NOT NULL AND to_org_id IS NOT NULL
       AND assignment_method IS NOT NULL AND assigned_by_user_id IS NOT NULL
       AND parked_duration_seconds IS NOT NULL)
    OR (event_type IN ('expired', 'purged')
       AND from_org_id IS NOT NULL AND to_org_id IS NULL
       AND assignment_method IS NULL)
    OR (event_type = 'reattached'
       AND from_org_id IS NOT NULL AND to_org_id IS NOT NULL
       AND assignment_method IS NULL AND assigned_by_user_id IS NOT NULL
       AND parked_duration_seconds IS NOT NULL)
  );
