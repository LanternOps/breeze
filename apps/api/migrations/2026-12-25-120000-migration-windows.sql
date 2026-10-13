-- Ticket migration windows (#8313, step 1 wave 1a).
-- Design: docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md §3.
--
-- A migration window grants ONE keyless partner service principal import mode,
-- for one time box, on an explicit list of the partner's organizations. This
-- file creates the window and its org list, plus the import marker and the
-- original-author / source-number columns the import writer (wave 1b) stamps.
-- The indexes on the existing, potentially large ticket tables are built
-- CONCURRENTLY in the next file (2026-12-23-110100).
--
-- Tenancy: both tables are partner-axis (shape 3), policy
-- `system OR breeze_has_partner_access(partner_id)`. migration_window_orgs
-- carries an org_id that is NOT its tenancy axis, so it is also registered in
-- the org cascade, the merge registry (repoint-dedupe on window_id) and the
-- export policy. Composite FKs pin a window to its partner's principal and
-- orgs; the org FK is DEFERRABLE INITIALLY IMMEDIATE because org merge defers
-- constraints while it re-points parent and child.
--
-- The import write locks its window FOR SHARE under the partner context
-- (spec §4.4). Postgres applies the UPDATE policy to a locking SELECT, so the
-- FOR ALL policy below is load-bearing for every import write: hardening
-- UPDATE to system-only would turn each one into a 409. An integration test
-- pins it (migrationWindowsRls.integration.test.ts).
--
-- opened_by / closed_by are ON DELETE SET NULL: org erasure and user deletion
-- must never abort on a window (orgCascadeFkOnDelete contract). A window whose
-- opener is gone loses opened_by and is closed as opener_inactive by the
-- sweep; the audit rows keep who opened and closed it.
--
-- Fully idempotent — safe to re-run. Nothing here writes rows.

CREATE TABLE IF NOT EXISTS migration_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  source_label varchar(64) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  writes_per_hour integer NOT NULL,
  opened_by uuid REFERENCES users(id) ON DELETE SET NULL,
  opener_credential_epoch integer NOT NULL,
  opener_mfa_epoch integer NOT NULL,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_reason text,
  closed_at timestamptz,
  summary jsonb,
  summary_published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_windows_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT migration_windows_principal_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT migration_windows_status_chk CHECK (status IN ('open', 'closed')),
  CONSTRAINT migration_windows_writes_per_hour_chk CHECK (writes_per_hour BETWEEN 600 AND 100000),
  CONSTRAINT migration_windows_closed_reason_chk CHECK (closed_reason IS NULL OR closed_reason IN
    ('expired', 'closed_by_admin', 'principal_inactive', 'opener_inactive')),
  CONSTRAINT migration_windows_span_chk CHECK (ends_at > opened_at),
  CONSTRAINT migration_windows_closed_shape_chk CHECK (
    (status = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL))
);

-- One open window per partner (spec §3.1). The service checks first; this is
-- the race-proof backstop.
CREATE UNIQUE INDEX IF NOT EXISTS migration_windows_one_open_per_partner
  ON migration_windows (partner_id) WHERE status = 'open';
-- The key routes ask "is a window open for this principal?" on every issue
-- and rotate.
CREATE INDEX IF NOT EXISTS migration_windows_principal_open_idx
  ON migration_windows (partner_service_principal_id) WHERE status = 'open';
-- The sweep scans open windows and closed windows whose summary is unpublished.
CREATE INDEX IF NOT EXISTS migration_windows_sweep_idx
  ON migration_windows (status, summary_published_at);
-- The FKs to users are otherwise unindexed (user deletion checks them).
CREATE INDEX IF NOT EXISTS migration_windows_opened_by_idx ON migration_windows (opened_by);
CREATE INDEX IF NOT EXISTS migration_windows_closed_by_idx ON migration_windows (closed_by);

CREATE TABLE IF NOT EXISTS migration_window_orgs (
  window_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  org_id uuid NOT NULL,
  CONSTRAINT migration_window_orgs_pkey PRIMARY KEY (window_id, org_id),
  CONSTRAINT migration_window_orgs_window_fk FOREIGN KEY (window_id, partner_id)
    REFERENCES migration_windows(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT migration_window_orgs_org_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);

-- Org cascade / org merge reach these rows by org_id.
CREATE INDEX IF NOT EXISTS migration_window_orgs_org_idx ON migration_window_orgs (org_id);
-- Partner erasure reaches them by partner_id.
CREATE INDEX IF NOT EXISTS migration_window_orgs_partner_idx ON migration_window_orgs (partner_id);

ALTER TABLE migration_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_windows FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY migration_windows_partner_access ON migration_windows
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE migration_window_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_window_orgs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY migration_window_orgs_partner_access ON migration_window_orgs
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The API connects as the unprivileged app role; without these grants every
-- statement is a 42501 regardless of the policies. DELETE is needed by
-- partner erasure and the org cascade.
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_windows TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_window_orgs TO breeze_app;

-- Import marker, original authors and source numbers (spec §3.2). All
-- nullable, so live rows are untouched and the ALTERs are metadata-only.
-- migration_window_id is an FK-less snapshot: it must outlive window
-- retention and never couple an org table to a partner table.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS migration_window_id uuid;

ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS migration_window_id uuid;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS original_author_email varchar(320);
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS original_author_kind text;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS import_source_id varchar(255);
DO $$ BEGIN
  ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_original_author_kind_chk
    CHECK (original_author_kind IS NULL OR original_author_kind IN ('staff', 'requester')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Every existing row has a NULL kind, so validation cannot fail; it only scans.
ALTER TABLE ticket_comments VALIDATE CONSTRAINT ticket_comments_original_author_kind_chk;

ALTER TABLE ticket_external_refs ADD COLUMN IF NOT EXISTS external_number varchar(255);
