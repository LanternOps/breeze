-- The built-in "Configuration Compliance Violation" alert template (#6669,
-- services/configComplianceAlertBridge.ts) was created with auto_resolve = true.
-- Its conditions ({"source":"config-policy-compliance"}) only mark where the
-- alert came from. The condition registry cannot evaluate them, so the alert
-- worker's auto-resolve sweep treated them as "no longer met" and closed each
-- compliance alert about two minutes after it opened, while the device was
-- still failing. These alerts are resolved by the bridge when the device
-- becomes compliant (policy.compliant), never by the sweep. The bridge now
-- creates the template with auto_resolve = false. This migration corrects the
-- row that a deployment already has.
--
-- It matches only the bridge's own row: global (org_id AND partner_id NULL),
-- built-in, with the bridge's name and source marker. A template with the same
-- name that an org or partner created is left alone.
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
   WHERE org_id IS NULL
     AND partner_id IS NULL
     AND is_built_in = true
     AND name = 'Configuration Compliance Violation'
     AND conditions->>'source' = 'config-policy-compliance'
     AND auto_resolve = true;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'config compliance alert template: auto_resolve turned off on % row(s)', n;
  END IF;
END $$;
