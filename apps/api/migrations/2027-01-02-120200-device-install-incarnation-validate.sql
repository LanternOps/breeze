-- @no-transaction
-- #8318 wave 1a — the install incarnation boundary, part 3 of 3: everything
-- that must not run inside one multi-table transaction. Each statement below
-- runs (and commits) on its own, so no statement ever holds one table's lock
-- while it waits for another's.
--
-- 1. The reason values the boundary writes (§5.5, §5.6): a live endpoint chat
--    closes with close_reason 'device_reinstalled'; live AI Operator tasks and
--    targets detach with detached_reason 'device_reinstalled'. Each CHECK is
--    swapped for a superset, NOT VALID (no scan; every existing row satisfies
--    the narrower shipped one), and only when it lacks the value, so a re-run
--    never turns a validated constraint back into a NOT VALID one. The TS
--    vocabularies (ENDPOINT_CONVERSATION_CLOSE_REASONS, and
--    AI_OPERATOR_TARGET_DETACH_REASONS in the schema and in @breeze/shared)
--    gain the same value.
--
-- 2. VALIDATE the four NOT VALID CHECKs (devices_install_incarnation_chk from
--    part 1, and the three swapped above). A VALIDATE inside a transactional
--    file would have held its ACCESS EXCLUSIVE lock through the scan; here
--    each runs under SHARE UPDATE EXCLUSIVE, so heartbeats keep writing
--    `devices`. Every existing devices row has install_incarnation = 1 and a
--    NULL incarnation_started_at (the column defaults), so it passes.
--
-- 3. idx_device_commands_device_open: the open (pending/sent) rows of one
--    device. The boundary cancels exactly that set inside the confirm
--    transaction while it holds the device row lock, and `device_commands`
--    has no general device_id index (2026-12-27-090000), so without this the
--    cancel would scan every open row in the fleet under that lock. It also
--    serves the claim's in-flight count (status = 'sent' per device).
--    Partial, so it stays as small as the open-row set. CONCURRENTLY because
--    device_commands is written on the agent hot path (same reasoning as
--    2026-11-19-101100 and 2026-12-27-090000).
--
-- lock_timeout bounds each ALTER's wait for its lock; it is RESET before the
-- CONCURRENTLY build, which waits for older transactions without blocking
-- writers and must not be cut short. Idempotent: the swaps are conditional,
-- VALIDATE on a validated constraint is a no-op, and a failed CONCURRENTLY
-- build leaves an INVALID index that IF NOT EXISTS would skip, so the final DO
-- block raises rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed. No tenancy change.

SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.endpoint_conversations'::regclass
       AND conname = 'endpoint_conversations_close_reason_chk'
       AND pg_get_constraintdef(oid) LIKE '%device_reinstalled%'
  ) THEN
    ALTER TABLE public.endpoint_conversations
      DROP CONSTRAINT IF EXISTS endpoint_conversations_close_reason_chk,
      ADD CONSTRAINT endpoint_conversations_close_reason_chk CHECK (
        close_reason IS NULL
        OR close_reason IN ('technician', 'idle', 'device_moved', 'agent', 'device_reinstalled')
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ai_operator_tasks'::regclass
       AND conname = 'ai_operator_tasks_target_detached_reason_chk'
       AND pg_get_constraintdef(oid) LIKE '%device_reinstalled%'
  ) THEN
    ALTER TABLE public.ai_operator_tasks
      DROP CONSTRAINT IF EXISTS ai_operator_tasks_target_detached_reason_chk,
      ADD CONSTRAINT ai_operator_tasks_target_detached_reason_chk CHECK (
        target_detached_reason IS NULL
        OR target_detached_reason IN ('device_moved', 'device_deleted', 'org_merged', 'scope_invalidated', 'device_reinstalled')
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ai_operator_task_targets'::regclass
       AND conname = 'ai_operator_task_targets_detached_reason_chk'
       AND pg_get_constraintdef(oid) LIKE '%device_reinstalled%'
  ) THEN
    ALTER TABLE public.ai_operator_task_targets
      DROP CONSTRAINT IF EXISTS ai_operator_task_targets_detached_reason_chk,
      ADD CONSTRAINT ai_operator_task_targets_detached_reason_chk CHECK (
        detached_reason IS NULL
        OR detached_reason IN ('device_moved', 'device_deleted', 'org_merged', 'scope_invalidated', 'device_reinstalled')
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.devices VALIDATE CONSTRAINT devices_install_incarnation_chk;
ALTER TABLE public.endpoint_conversations VALIDATE CONSTRAINT endpoint_conversations_close_reason_chk;
ALTER TABLE public.ai_operator_tasks VALIDATE CONSTRAINT ai_operator_tasks_target_detached_reason_chk;
ALTER TABLE public.ai_operator_task_targets VALIDATE CONSTRAINT ai_operator_task_targets_detached_reason_chk;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_device_open
  ON public.device_commands (device_id)
  WHERE status IN ('pending', 'sent');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.device_commands'::regclass
       AND c.relname = 'idx_device_commands_device_open'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_device_commands_device_open build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
