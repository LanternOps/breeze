-- Enforce the #rrggbb hex-color shape on partner_login_branding.accent_color
-- at the DB layer (#2194 review follow-up). The web/API validators already
-- reject non-hex values on write (partnerLoginBranding.ts's brandingSchema),
-- but that's app-layer-only -- a direct DB write (script, future admin tool,
-- manual fix) could still leave a malformed value for the login page to
-- render verbatim into CSS. Belt-and-suspenders: same shape as the Zod check.
--
-- Idempotent: guarded CHECK add (mirrors sso_providers_one_owner_chk in
-- 2026-07-03-sso-partner-axis-login-branding.sql). No inner BEGIN/COMMIT
-- (autoMigrate wraps each file).

-- Clean up any pre-existing non-conforming rows before adding the CHECK, so
-- the ALTER TABLE below doesn't fail on data written before this constraint
-- existed. Report the count so a non-zero cleanup leaves a forensic trail.
DO $$
DECLARE
  n int;
BEGIN
  UPDATE partner_login_branding
  SET accent_color = NULL
  WHERE accent_color IS NOT NULL
    AND accent_color !~ '^#[0-9a-fA-F]{6}$';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % partner_login_branding row(s) with malformed accent_color', n;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_login_branding_accent_hex_chk'
      AND conrelid = 'partner_login_branding'::regclass
  ) THEN
    ALTER TABLE partner_login_branding
      ADD CONSTRAINT partner_login_branding_accent_hex_chk
      CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END $$;
