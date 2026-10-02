-- AI model registry W05 (#7603), spec §9.2 / §15 #4: a chat that cannot
-- resume on the model the tech switched to continues in a NEW session seeded
-- with a summary. This links the new session to the one it continues.
--
-- Tenancy: ai_sessions is shape 1 (org_id) and already in every cascade,
-- merge and device-move list. The link is a composite self-FK on
-- (continued_from_session_id, org_id) → ai_sessions(id, org_id) (unique
-- index ai_sessions_id_org_uidx), so it can never point into another org
-- (quorum #1). DEFERRABLE INITIALLY IMMEDIATE: org merge re-points org_id
-- under SET CONSTRAINTS ALL DEFERRED (CLAUDE.md merge contract).
-- ON DELETE SET NULL (continued_from_session_id): deleting the source keeps
-- the continuation; the column-list form leaves org_id untouched (PG15+).
-- A continuation copies its source's device_id, so the device-move cascade's
-- one `UPDATE … WHERE device_id` re-stamps both rows of a pair together.
-- Export: CORE_TENANT_EXPORT_POLICY classifies the column `included`.
-- DDL only: no row writes, so no system-scope election is needed.

ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS continued_from_session_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_continued_from_fk' AND conrelid = 'public.ai_sessions'::regclass
  ) THEN
    ALTER TABLE public.ai_sessions
      ADD CONSTRAINT ai_sessions_continued_from_fk
      FOREIGN KEY (continued_from_session_id, org_id)
      REFERENCES public.ai_sessions (id, org_id)
      ON DELETE SET NULL (continued_from_session_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

ALTER TABLE public.ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_continued_from_not_self_chk;
ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_continued_from_not_self_chk
  CHECK (continued_from_session_id IS NULL OR continued_from_session_id <> id);

CREATE INDEX IF NOT EXISTS ai_sessions_continued_from_idx
  ON public.ai_sessions (continued_from_session_id)
  WHERE continued_from_session_id IS NOT NULL;
