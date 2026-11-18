-- #9496: drop the inert ai_model_assignments rows of platform-only surfaces.
--
-- patch_test resolves the partnerless platform default (resolveModel's
-- platform-only branch) and never reads an assignment, and no API or UI row can
-- write or manage one (CONFIGURABLE_AI_SURFACES excludes it). The registry
-- bootstrap nevertheless wrote a partner-level patch_test row for every
-- partner. The row changes no routing, but it pins the offering it points at:
-- it kept that offering enabled after a partner connected a key, and its
-- non-cascading default FK made a hand-added model that it referenced
-- unremovable. The bootstrap no longer writes it; this removes the existing
-- ones. Idempotent: a re-run deletes nothing.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.ai_model_assignments WHERE surface = 'patch_test';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % inert platform-only (patch_test) ai_model_assignments rows (#9496)', n;
  END IF;
END $$;
