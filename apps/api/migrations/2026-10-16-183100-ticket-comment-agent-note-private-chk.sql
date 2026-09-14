-- #4209 (W03): an ai_agent-authored ticket comment can never be customer-facing.
--
-- addAiTriageNote() already hardcodes is_public=false and manage_tickets' comment
-- branch ignores a caller-supplied isPublic for an ai_agent principal, but both
-- are application-layer. The requirement is "isPublic FORCED false", and the only
-- place a force survives a future writer is the database.
--
-- Scoped to origin_principal_kind='ai_agent' ONLY: every other value in the
-- column's CHECK ('user', 'system', 'unknown') is untouched. The column's
-- DEFAULT is 'user' (portal.ts, a deliberate deviation from action_intents'
-- fail-closed default), so no existing insert path that omits the column can
-- be affected by this constraint at all.
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
