-- Fix-forward for 2026-10-01-100000-ai-agents-graduation-evidence.sql (#4187 P2-5).
--
-- That migration added three composite (x, org_id) foreign keys without a
-- DEFERRABLE clause, so Postgres created them NOT DEFERRABLE:
--
--   ai_agent_op_evidence.ai_agent_op_evidence_run_org_fk
--   ai_agent_graduation.ai_agent_graduation_intent_org_fk
--   ai_agent_fix_watches.ai_agent_fix_watches_intent_org_fk
--
-- The org-merge contract requires every composite FK that references an
-- `org_id` column to be DEFERRABLE INITIALLY IMMEDIATE: orgMerge.ts runs
-- `SET CONSTRAINTS ALL DEFERRED` and re-points the parent's and the child's
-- `org_id` in separate statements, which a non-deferrable composite FK aborts
-- mid-merge. 2026-09-12-100001-org-lifecycle-foundations.sql Section 2 swept
-- the composite org_id FKs that existed when it shipped; these three were
-- created after it and so were never covered.
--
-- The shipped file is content-hash immutable, so this fixes forward. The
-- deferrability of an existing FK is changed in place with ALTER CONSTRAINT
-- (the same statement Section 2 of the org-lifecycle migration uses) — no
-- DROP + re-ADD, which would take the same lock but additionally re-validate
-- every existing row and require the column list, referenced table and
-- ON DELETE action to be restated by hand.
--
-- Scoped to these three constraint names ON PURPOSE. A blanket sweep would
-- also silently repair any future non-deferrable composite org_id FK that
-- happened to be in the database when it ran, which is precisely the failure
-- this migration exists to correct: the contract test must stay the thing that
-- catches a new offender.
--
-- Idempotent: the loop selects only `condeferrable = false`, so a second run
-- matches nothing and does nothing.

DO $$
DECLARE
  fk record;
  n integer := 0;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass AS child_table
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.condeferrable = false
      AND con.connamespace = 'public'::regnamespace
      AND con.conname IN (
        'ai_agent_op_evidence_run_org_fk',
        'ai_agent_graduation_intent_org_fk',
        'ai_agent_fix_watches_intent_org_fk'
      )
    ORDER BY con.conrelid::regclass::text, con.conname
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
                   fk.child_table, fk.conname);
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE WARNING 'ai-agents graduation: made % composite org_id FKs deferrable', n;
  END IF;
END $$;
