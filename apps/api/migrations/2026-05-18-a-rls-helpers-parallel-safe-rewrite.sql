-- 2026-05-18: rewrite breeze_accessible_org_ids() / _partner_ids() to drop
-- EXCEPTION blocks so they are GENUINELY parallel-safe.
--
-- Background: 2026-05-17-e marked these (and three siblings) PARALLEL SAFE
-- LEAKPROOF, but the function bodies were plpgsql with `EXCEPTION WHEN others`.
-- Postgres EXCEPTION blocks create implicit subtransactions, which cannot
-- run inside a parallel worker. Once Phase 2's new indexes (devices,
-- audit_logs, alerts, device_software, script_executions) tipped the
-- planner toward parallel scans on /devices, RLS evaluation crashed with
-- "cannot start subtransactions during a parallel operation" and every
-- /devices request 500'd.
--
-- Fix: replace EXCEPTION-based defensive parse with explicit regex
-- pre-validation of the GUC payload. Same fail-closed semantics, no
-- implicit subtransaction, truly parallel-safe.
--
-- Idempotent. Safe to re-apply.

CREATE OR REPLACE FUNCTION public.breeze_accessible_org_ids()
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.accessible_org_ids', true);
  IF raw = '*' THEN RETURN NULL; END IF;
  IF raw IS NULL OR raw = '' THEN RETURN ARRAY[]::uuid[]; END IF;
  IF raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(,[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})*$' THEN
    RETURN string_to_array(raw, ',')::uuid[];
  END IF;
  RETURN ARRAY[]::uuid[];
END;
$function$;

CREATE OR REPLACE FUNCTION public.breeze_accessible_partner_ids()
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.accessible_partner_ids', true);
  IF raw = '*' THEN RETURN NULL; END IF;
  IF raw IS NULL OR raw = '' THEN RETURN ARRAY[]::uuid[]; END IF;
  IF raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(,[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})*$' THEN
    RETURN string_to_array(raw, ',')::uuid[];
  END IF;
  RETURN ARRAY[]::uuid[];
END;
$function$;

-- Best-effort LEAKPROOF (requires superuser). The previous migration
-- (2026-05-17-e) wrapped the same pattern for the sibling helpers; mirror it
-- here for these two.
DO $$
BEGIN
  ALTER FUNCTION public.breeze_accessible_org_ids() LEAKPROOF;
  ALTER FUNCTION public.breeze_accessible_partner_ids() LEAKPROOF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipped LEAKPROOF (requires superuser); PARALLEL SAFE applied.';
END $$;
