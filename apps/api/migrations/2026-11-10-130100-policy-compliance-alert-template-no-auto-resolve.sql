-- The per-org "Policy Compliance Violation" alert templates that the
-- automation-policy alert bridge creates (services/policyAlertBridge.ts
-- `ensureTemplate`) were created with auto_resolve = true. Their conditions
-- ({"source":"policy-evaluation"}) only mark where the alert came from. The
-- condition registry cannot evaluate them, so the alert worker's auto-resolve
-- sweep treated them as "no longer met" and closed each policy alert shortly
-- after it opened, while the device was still failing. The same fault on the
-- configuration-policy template was fixed by
-- 2026-11-10-120100-config-compliance-alert-template-no-auto-resolve.sql.
-- These alerts are resolved by the bridge on policy.compliant, or by the
-- compliance-alert reconcile when the policy stops applying; never by the
-- sweep. The bridge now creates the template with auto_resolve = false, and
-- this migration corrects the rows a deployment already has.
--
-- It matches only the bridge's own rows: org-owned, built-in, with the
-- bridge's name and source marker. A same-named template an org authored
-- itself (is_built_in = false) is left alone.
--
-- WRITES ROWS: system scope is set first, because FORCE RLS applies to the
-- migration role. The count is logged when rows change. Idempotent: a second
-- run matches nothing.
-- autoMigrate wraps this file in a transaction, so there is no BEGIN/COMMIT here.
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.alert_templates
     SET auto_resolve = false,
         updated_at = now()
   WHERE org_id IS NOT NULL
     AND is_built_in = true
     AND name = 'Policy Compliance Violation'
     AND conditions->>'source' = 'policy-evaluation'
     AND auto_resolve = true;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'policy compliance alert template: auto_resolve turned off on % row(s)', n;
  END IF;
END $$;
