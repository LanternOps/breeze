-- Per-org customer-portal "chrome accent" preset (packages/shared/src/types/
-- portalChromeAccent.ts). A partner picks one of the 8 curated keys
-- (PORTAL_CHROME_ACCENT_KEYS); NULL means the default ('spruce'). The API
-- validates writes against the same key list — this constraint is a second,
-- database-level guarantee that the column can never hold a stray value.
--
-- Export policy: chrome_accent is classified 'included' in
-- CORE_TENANT_EXPORT_POLICY (tenantExportPolicyRegistry.ts) in this same PR —
-- portal_branding is an org-cascade table, so every column must be
-- classified. It is a plain enum-shaped varchar (no SUSPICIOUS_NAME_PARTS
-- hit, not jsonb/bytea), so `included` is correct.
--
-- RLS: portal_branding is shape 1 (direct org_id); a new column does not
-- change the shape, so rls-coverage.integration.test.ts needs no allowlist
-- entry.
--
-- DDL ONLY: no UPDATE / DELETE / INSERT / MERGE, so no
-- `SELECT set_config('breeze.scope','system',true);` elevation is required
-- (migrationRlsScope.test.ts only flags files that write rows).
--
-- Idempotent: IF NOT EXISTS on the column, and a pg_constraint existence
-- check before adding the CHECK (same shape as
-- 2026-10-16-183100-ticket-comment-agent-note-private-chk.sql). Re-applying
-- is a no-op. No inner BEGIN/COMMIT — autoMigrate wraps each file in its own
-- transaction.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS chrome_accent varchar(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'portal_branding_chrome_accent_chk'
  ) THEN
    ALTER TABLE portal_branding
      ADD CONSTRAINT portal_branding_chrome_accent_chk
      CHECK (chrome_accent IS NULL OR chrome_accent IN (
        'spruce', 'ink', 'oxblood', 'navy', 'plum', 'bronze', 'teal', 'forest'
      ));
  END IF;
END $$;
