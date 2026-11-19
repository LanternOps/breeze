-- Portal registration W4 (#11381): Entra tenant proof on the org's tenant mapping (spec §5.4, plan D1).
-- DDL only; system scope first per migrations/README. autoMigrate wraps the file: no BEGIN/COMMIT.
-- client_ai_tenant_mappings keeps its shape-1 RLS (2026-06-12-b-client-ai-foundation.sql); no policy change.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.client_ai_tenant_mappings
  ADD COLUMN IF NOT EXISTS proven_at timestamptz,
  ADD COLUMN IF NOT EXISTS proven_via text,
  ADD COLUMN IF NOT EXISTS proven_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proven_evidence jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.client_ai_tenant_mappings'::regclass
                  AND conname = 'client_ai_tenant_mappings_proven_via_chk') THEN
    ALTER TABLE public.client_ai_tenant_mappings ADD CONSTRAINT client_ai_tenant_mappings_proven_via_chk
      CHECK (proven_via IS NULL OR proven_via IN ('m365_connection','proof_run'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.client_ai_tenant_mappings'::regclass
                  AND conname = 'client_ai_tenant_mappings_proof_shape_chk') THEN
    ALTER TABLE public.client_ai_tenant_mappings ADD CONSTRAINT client_ai_tenant_mappings_proof_shape_chk
      CHECK ((proven_at IS NULL) = (proven_via IS NULL) AND (proven_at IS NULL) = (proven_evidence IS NULL));
  END IF;
  -- The evidence names its method and carries that method's keys (PortalEntraProofEvidence).
  -- The first three disjuncts hand a missing via, or one outside the vocabulary, to the two
  -- checks above: Postgres runs CHECKs in name order and this one sorts first, so without them
  -- it would report every such row in their place. IS NOT DISTINCT FROM keeps an evidence object
  -- with no `via` key (or a non-object) from evaluating to NULL, which a CHECK would let pass.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.client_ai_tenant_mappings'::regclass
                  AND conname = 'client_ai_tenant_mappings_proof_evidence_chk') THEN
    ALTER TABLE public.client_ai_tenant_mappings ADD CONSTRAINT client_ai_tenant_mappings_proof_evidence_chk
      CHECK (proven_evidence IS NULL
             OR proven_via IS NULL
             OR proven_via NOT IN ('m365_connection','proof_run')
             OR ((proven_evidence->>'via') IS NOT DISTINCT FROM proven_via
                 AND ((proven_via = 'proof_run' AND proven_evidence ? 'adminOid' AND proven_evidence ? 'runId')
                   OR (proven_via = 'm365_connection' AND proven_evidence ? 'connectionId' AND proven_evidence ? 'profile'))));
  END IF;
END $$;

-- inv. 3: a proof is about ONE tenant. Any writer that changes the tenant (e.g. the AI for
-- Office PUT /tenant-mapping upsert) drops the proof unless it records a new one itself.
CREATE OR REPLACE FUNCTION public.client_ai_tenant_mappings_clear_proof_on_repoint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entra_tenant_id IS DISTINCT FROM OLD.entra_tenant_id
     AND NEW.proven_at IS NOT DISTINCT FROM OLD.proven_at THEN
    NEW.proven_at := NULL; NEW.proven_via := NULL; NEW.proven_by_user_id := NULL; NEW.proven_evidence := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS client_ai_tenant_mappings_clear_proof_on_repoint ON public.client_ai_tenant_mappings;
CREATE TRIGGER client_ai_tenant_mappings_clear_proof_on_repoint
  BEFORE UPDATE ON public.client_ai_tenant_mappings
  FOR EACH ROW EXECUTE FUNCTION public.client_ai_tenant_mappings_clear_proof_on_repoint();
