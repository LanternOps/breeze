-- PAM UAC interception: switch from opt-out (default ON) to opt-in (default OFF).
--
-- Previously a Windows device with no 'pam' config-policy feature link still
-- captured UAC elevation events and prompted the end user — capture was ON by
-- default. The product default is now opt-in: no capture, no prompt, until an
-- admin enables it via a config policy.
--
-- To avoid silently disabling PAM for orgs that had DELIBERATELY configured it
-- before this switch, grandfather them to ON via a new org-level fallback flag.
-- "Deliberate configuration" = authored approval rules (pam_rules), signer
-- groups (pam_signer_groups), or a changed unmatched-verdict default
-- (pam_org_config.default_unmatched_verdict <> 'require_approval').
--
-- elevation_requests history is EXCLUDED on purpose: those rows are the symptom
-- of the old default-ON behavior (a user clicked through a prompt), not evidence
-- that the admin wanted PAM. Grandfathering on them would re-enable capture for
-- exactly the orgs the opt-in switch is meant to spare.
--
-- Resolution order (see resolveDevicePamSettings): a 'pam' config-policy feature
-- link always wins; this column is the org-level fallback; NULL means "no
-- opinion" → the global opt-in default (off).

ALTER TABLE pam_org_config
  ADD COLUMN IF NOT EXISTS uac_interception_enabled boolean;

DO $$
DECLARE
  n integer;
BEGIN
  WITH active_pam_orgs AS (
    SELECT org_id FROM pam_rules
    UNION
    SELECT org_id FROM pam_signer_groups
    UNION
    SELECT org_id FROM pam_org_config WHERE default_unmatched_verdict <> 'require_approval'
  )
  INSERT INTO pam_org_config (org_id, uac_interception_enabled)
  SELECT org_id, true FROM active_pam_orgs
  ON CONFLICT (org_id) DO UPDATE
    SET uac_interception_enabled = true,
        updated_at = now()
  WHERE pam_org_config.uac_interception_enabled IS DISTINCT FROM true;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'pam opt-in grandfathering: enabled UAC capture for % org(s) with deliberate PAM config', n;
  END IF;
END $$;
