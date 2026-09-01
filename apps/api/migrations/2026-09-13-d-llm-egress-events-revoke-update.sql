-- #3922 review round 2: narrow `breeze_app`'s privileges on llm_egress_events.
--
-- 2026-09-13-c created the table with a blanket
-- `GRANT SELECT, INSERT, UPDATE, DELETE`. UPDATE is wrong here: an egress event
-- is a statement about something that already happened, so a tenant-reachable
-- role that can rewrite `host`, `blocked` or `resolved_ip` after the fact turns
-- the audit trail into a claim rather than a record. Nothing in the API updates
-- this table — the recorder only INSERTs — so the privilege is pure attack
-- surface.
--
-- DELETE stays: `llm_egress_events` is in CORE_ORG_CASCADE_DELETE_ORDER and org
-- erasure has to be able to remove these rows.
--
-- Fixed forward in its own file rather than by editing 2026-09-13-c, which has
-- already shipped to main (#4115) and is content-hash immutable.
--
-- The matching `ensureAppRole` change is what keeps this from being undone: the
-- boot-time role reconciler re-issued a blanket table GRANT on every start, so
-- narrowing the privilege here alone would silently revert on the next restart.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'llm_egress_events'
  ) AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app'
  ) THEN
    REVOKE UPDATE ON llm_egress_events FROM breeze_app;
    GRANT SELECT, INSERT, DELETE ON llm_egress_events TO breeze_app;
  END IF;
END $$;
