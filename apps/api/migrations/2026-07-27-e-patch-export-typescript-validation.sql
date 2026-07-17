-- Fix forward 07-27-d: PostgreSQL text/number semantics cannot exactly model
-- JavaScript's UTF-16 string length, locale-independent toLowerCase(), or
-- IEEE-754 JSON parsing. Carry the raw patch mirror as an internal material;
-- the partner route removes this key and applies the shared Zod validator
-- before safety inspection, revision hashing, or DTO assembly.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_patch_mirror_projection(mirror jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('__breezePatchInlineMirror', mirror)
$$;

-- Preserve the invoker/ACL contract established by 07-27-d.
REVOKE ALL ON FUNCTION public.breeze_partner_export_patch_mirror_projection(jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_partner_export_patch_mirror_projection(jsonb) TO breeze_app;
  END IF;
END
$$;
