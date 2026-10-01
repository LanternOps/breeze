-- AI model registry W02 (#7600, spec §5.6): which offering a chat session and
-- an AI agent policy are bound to. Columns + constraints only; the W02 boot
-- reconcile backfills live sessions and every agent row from their legacy
-- `model` string. Routing keeps reading `model` until W03.
--
-- Composite FKs (quorum #1), both sides:
--   (offering_id, offering_partner_id) -> partner_ai_models(id, partner_id)
--       ON DELETE SET NULL (an offering removed with its connection unbinds the
--       session/policy; the legacy `model` provenance stays)
--   (org_id, offering_partner_id) -> organizations(id, partner_id)
--       DEFERRABLE INITIALLY IMMEDIATE (org merge contract; merges are
--       same-partner). On ai_agents, partner rows have org_id NULL, so only
--       org rows are checked; partner rows carry a CHECK instead.
--
-- ai_sessions is device-denormalized (CORE_DEVICE_ORG_DENORMALIZED_TABLES):
-- a system-scope CROSS-PARTNER device move re-stamps a device-bound session's
-- org_id, which would violate the org composite FK. The guard trigger clears
-- the offering pair (and options) on an org change into another partner, so the
-- move succeeds and the session falls back to the new partner's assignment —
-- same posture as the topology alert ownership guard (2026-11-06-210400).
--
-- LOCKS: ai_sessions is large and hot. ADD COLUMN (no default) is
-- metadata-only, but this whole file is one transaction, so its ACCESS
-- EXCLUSIVE lock would be held through any validation scan. The ai_sessions
-- constraints are therefore added NOT VALID (no scan) and validated by -100500
-- under SHARE UPDATE EXCLUSIVE; the index is built CONCURRENTLY by -100600.
-- Precedent: 2026-07-17-a-device-vulnerabilities-software-fk-set-null.sql.
-- ai_agents is small and is validated inline.
--
-- Constraints are added only when missing (never dropped and re-added), so a
-- replay can't turn a validated constraint back into NOT VALID.
-- The stale ai_sessions.model default is deliberately NOT dropped here (W03).
-- Idempotent. Writes no rows.

ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS offering_id uuid;
ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS offering_partner_id uuid;
ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS options jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_offering_shape_chk' AND conrelid = 'public.ai_sessions'::regclass) THEN
    ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_offering_shape_chk CHECK (
      (offering_id IS NULL) = (offering_partner_id IS NULL)
      AND (options IS NULL OR jsonb_typeof(options) = 'object')
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_offering_fk' AND conrelid = 'public.ai_sessions'::regclass) THEN
    ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_offering_fk
      FOREIGN KEY (offering_id, offering_partner_id)
      REFERENCES public.partner_ai_models (id, partner_id) ON DELETE SET NULL
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_offering_org_partner_fk' AND conrelid = 'public.ai_sessions'::regclass) THEN
    ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_offering_org_partner_fk
      FOREIGN KEY (org_id, offering_partner_id)
      REFERENCES public.organizations (id, partner_id)
      DEFERRABLE INITIALLY IMMEDIATE
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_ai_sessions_offering_partner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.offering_partner_id IS NOT NULL
     AND NEW.org_id IS DISTINCT FROM OLD.org_id
     AND NOT EXISTS (
       SELECT 1 FROM public.organizations AS o
        WHERE o.id = NEW.org_id AND o.partner_id = NEW.offering_partner_id
     ) THEN
    NEW.offering_id := NULL;
    NEW.offering_partner_id := NULL;
    NEW.options := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS breeze_ai_sessions_offering_partner_guard ON public.ai_sessions;
CREATE TRIGGER breeze_ai_sessions_offering_partner_guard
  BEFORE UPDATE OF org_id ON public.ai_sessions
  FOR EACH ROW EXECUTE FUNCTION public.breeze_ai_sessions_offering_partner_guard();

ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS offering_id uuid;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS offering_partner_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_offering_shape_chk' AND conrelid = 'public.ai_agents'::regclass) THEN
    ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_offering_shape_chk CHECK (
      (offering_id IS NULL) = (offering_partner_id IS NULL)
      -- a partner-wide policy may only bind its own partner's offering
      AND (partner_id IS NULL OR offering_partner_id IS NULL OR partner_id = offering_partner_id)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_offering_fk' AND conrelid = 'public.ai_agents'::regclass) THEN
    ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_offering_fk
      FOREIGN KEY (offering_id, offering_partner_id)
      REFERENCES public.partner_ai_models (id, partner_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_offering_org_partner_fk' AND conrelid = 'public.ai_agents'::regclass) THEN
    ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_offering_org_partner_fk
      FOREIGN KEY (org_id, offering_partner_id)
      REFERENCES public.organizations (id, partner_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_agents_offering_idx
  ON public.ai_agents (offering_id) WHERE offering_id IS NOT NULL;
