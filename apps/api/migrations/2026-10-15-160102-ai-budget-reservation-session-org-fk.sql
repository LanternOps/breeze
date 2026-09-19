-- A reservation may reference only a session in the same organization. The
-- direct-org RLS policy protects org_id but cannot enforce this relationship
-- when a caller knows a foreign session UUID.

CREATE UNIQUE INDEX IF NOT EXISTS ai_sessions_id_org_uidx
  ON ai_sessions (id, org_id);

ALTER TABLE ai_budget_reservations
  DROP CONSTRAINT IF EXISTS ai_budget_reservations_session_id_fkey;
ALTER TABLE ai_budget_reservations
  DROP CONSTRAINT IF EXISTS ai_budget_reservations_session_id_ai_sessions_id_fk;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_budget_reservations_session_org_fk'
      AND conrelid = 'ai_budget_reservations'::regclass
  ) THEN
    ALTER TABLE ai_budget_reservations
      ADD CONSTRAINT ai_budget_reservations_session_org_fk
      FOREIGN KEY (session_id, org_id)
      REFERENCES ai_sessions(id, org_id)
      ON DELETE SET NULL (session_id)
      -- DEFERRABLE INITIALLY IMMEDIATE is REQUIRED, not stylistic: org merge
      -- (`orgMerge.ts`) runs SET CONSTRAINTS ALL DEFERRED and re-points the
      -- parent's and the child's org_id in separate statements, so a
      -- non-deferrable composite (x, org_id) FK aborts the merge. Enforced by
      -- orgLifecycleFoundations.integration.test.ts.
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
