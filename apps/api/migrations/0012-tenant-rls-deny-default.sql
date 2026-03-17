-- Tighten RLS defaults: missing request/job scope should deny access.
-- Explicit context must now be set via withDbAccessContext.

BEGIN;

CREATE OR REPLACE FUNCTION public.breeze_current_scope()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('breeze.scope', true), ''), 'none');
$$;

COMMIT;
