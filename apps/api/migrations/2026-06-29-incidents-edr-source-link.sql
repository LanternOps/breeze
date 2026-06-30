-- Link a tracked incident back to the EDR record it was promoted from, so the
-- /incidents/feed union can suppress findings that already became incidents.
-- incidents is org-scoped (RLS shape #1); adding columns does not change tenancy.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_ref text;

-- Forward-compat hook for identity-based (ITDR) findings; unused until an ITDR
-- ingestion path exists. Device-based findings keep using affected_devices.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS affected_users jsonb NOT NULL DEFAULT '[]'::jsonb;

-- One tracked incident per (org, EDR source record). Partial: only enforced when
-- a source_ref is present, so manually-created incidents (no source) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_ref_unique
  ON incidents (org_id, source_type, source_ref)
  WHERE source_ref IS NOT NULL;
