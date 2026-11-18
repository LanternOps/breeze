-- action_intents.status_changed_at, stamped by a BEFORE UPDATE trigger on
-- every status change (B-W06 #6160, D-B50).
--
-- The MCP Tasks extension reports a task's `lastUpdatedAt`. Several writers
-- change only `status` (and sometimes `error_code`) on an intent — the
-- cancel CAS, the expiry reaper, the stale-executing reaper — so a time
-- derived from decided_at / execution_started_at / executed_at misses real
-- transitions. A trigger stamps the column for every writer, including ones
-- added later that know nothing about Tasks.
--
--   * ADD COLUMN without a default: existing rows stay NULL, nothing is
--     backfilled or rewritten (readers fall back to the latest older stamp).
--   * SET DEFAULT now() afterwards: new rows are stamped at insert.
--   * On UPDATE, the trigger takes clock_timestamp() when the status changes
--     and otherwise restores OLD.status_changed_at, so no application write
--     can forge or clear it. clock_timestamp(), not now(): now() is the
--     transaction start, and a long release-worker transaction could stamp a
--     time earlier than a transition a client already observed.
--
-- Not on action_intents_block_content_update()'s deny-list: this is mutable
-- lifecycle data, owned by its own trigger.
--
-- Tenancy: one column on an already-registered table. action_intents stays in
-- CORE_ORG_CASCADE_DELETE_ORDER and orgMergeRegistry.ts unchanged;
-- CORE_TENANT_EXPORT_POLICY lists status_changed_at under `included`. No RLS
-- policy change. No row writes, so no breeze.scope line.

ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE action_intents ALTER COLUMN status_changed_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION action_intents_stamp_status_changed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := clock_timestamp();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS action_intents_stamp_status_changed_at ON action_intents;
CREATE TRIGGER action_intents_stamp_status_changed_at
  BEFORE UPDATE ON action_intents
  FOR EACH ROW EXECUTE FUNCTION action_intents_stamp_status_changed_at();
