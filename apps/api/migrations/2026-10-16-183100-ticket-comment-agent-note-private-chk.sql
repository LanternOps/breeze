-- #4209 (W03): an ai_agent-authored ticket comment can never be customer-facing.
--
-- addAiTriageNote() already hardcodes is_public=false and manage_tickets' comment
-- branch ignores a caller-supplied isPublic for an ai_agent principal, but both
-- are application-layer. The requirement is "isPublic FORCED false", and the only
-- place a force survives a future writer is the database.
--
-- Scoped to origin_principal_kind='ai_agent' ONLY: 'system' rows (org-move feed
-- entries etc.) and 'user' rows are untouched, and 'unknown' stays unconstrained
-- so the fail-closed default value cannot brick an insert path.
--
-- NOT VALID is deliberately NOT used: there is no legal pre-existing violating
-- row (every ai_agent row was written by addAiTriageNote, which has hardcoded
-- false since it shipped), so a validating add is correct and gives us the
-- backfill check for free. If it fails on a real database, that failure IS the
-- finding — do not downgrade the constraint, investigate the rows.
--
-- No DML in this file, so no breeze.scope elevation is needed (and this file
-- must never be added to migrationRlsScope.test.ts's frozen baseline).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_agent_note_private_chk'
  ) THEN
    ALTER TABLE ticket_comments
      ADD CONSTRAINT ticket_comments_agent_note_private_chk
      CHECK (origin_principal_kind <> 'ai_agent' OR is_public = false);
  END IF;
END $$;
