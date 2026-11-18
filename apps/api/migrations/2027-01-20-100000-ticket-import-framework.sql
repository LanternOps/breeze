-- Ticket import framework (#8313 W4).
-- Design: docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md §5.5.
--
-- Six partner-axis tables (shape 3) for the import worker: a connected source
-- (one per keyless import principal, with its row-bound credential), its org
-- and category maps, its runs, its per-source ticket ledger and the run
-- report's issue rows.
--
-- Partner-wide first: none of these is a config table an org could own. An
-- import spans orgs and is a partner-admin action (#8313 answer 2), so every
-- table is `partner_id NOT NULL` with no `org_id` owner. The only org id is
-- ticket_import_org_maps.org_id, a TARGET org, not the row's tenant: it is in
-- ORG_AXIS_POLICY_EXCLUDED_TABLES, the org cascade, the merge registry
-- (repoint) and the export policy, and its composite FK is DEFERRABLE
-- INITIALLY IMMEDIATE because org merge defers constraints while it re-points
-- parent and child.
--
-- ON DELETE: users SET NULL (an audit trail never blocks a user's deletion),
-- orgs and categories CASCADE (a deleted target simply unmaps), a source
-- cascades to its maps, runs, ledger and issues, and a deleted principal
-- cascades its source, as it already cascades its windows.
--
-- One FOR ALL policy per table, `system OR breeze_has_partner_access(partner_id)`,
-- ENABLE + FORCE, and the grants breeze_app needs (DELETE for partner erasure,
-- the org cascade and source deletion). Fully idempotent; nothing here writes
-- rows.

CREATE TABLE IF NOT EXISTS ticket_import_sources (
  id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  module varchar(32) NOT NULL,
  label varchar(64) NOT NULL,
  base_url text NOT NULL,
  credentials_encrypted text,
  partner_service_principal_id uuid NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_sources_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT ticket_import_sources_principal_uq UNIQUE (partner_service_principal_id),
  CONSTRAINT ticket_import_sources_principal_fk FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_sources_revoked_chk CHECK ((revoked_at IS NULL) = (credentials_encrypted IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ticket_import_sources_partner_idx ON ticket_import_sources (partner_id);
CREATE INDEX IF NOT EXISTS ticket_import_sources_created_by_idx ON ticket_import_sources (created_by);
CREATE INDEX IF NOT EXISTS ticket_import_sources_revoked_by_idx ON ticket_import_sources (revoked_by);

CREATE TABLE IF NOT EXISTS ticket_import_org_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_org_key varchar(255),
  source_org_name varchar(255),
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_org_maps_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_org_maps_org_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);

-- One row per source org, and at most one fallback (the NULL key).
CREATE UNIQUE INDEX IF NOT EXISTS ticket_import_org_maps_source_key_uq
  ON ticket_import_org_maps (source_id, source_org_key) WHERE source_org_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_import_org_maps_fallback_uq
  ON ticket_import_org_maps (source_id) WHERE source_org_key IS NULL;
-- Org cascade / org merge reach these rows by org_id; partner erasure by partner_id.
CREATE INDEX IF NOT EXISTS ticket_import_org_maps_org_idx ON ticket_import_org_maps (org_id);
CREATE INDEX IF NOT EXISTS ticket_import_org_maps_partner_idx ON ticket_import_org_maps (partner_id);

CREATE TABLE IF NOT EXISTS ticket_import_category_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_group_key varchar(255) NOT NULL,
  source_group_name varchar(255),
  category_id uuid NOT NULL,
  CONSTRAINT ticket_import_category_maps_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_category_maps_category_fk FOREIGN KEY (category_id, partner_id)
    REFERENCES ticket_categories(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_category_maps_uq UNIQUE (source_id, source_group_key)
);

CREATE INDEX IF NOT EXISTS ticket_import_category_maps_category_idx ON ticket_import_category_maps (category_id);
CREATE INDEX IF NOT EXISTS ticket_import_category_maps_partner_idx ON ticket_import_category_maps (partner_id);

CREATE TABLE IF NOT EXISTS ticket_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  kind text NOT NULL,
  window_id uuid,
  state text NOT NULL DEFAULT 'queued',
  stop_reason text,
  phase text NOT NULL DEFAULT 'scan',
  cursor jsonb NOT NULL DEFAULT '{}',
  slice_seq integer NOT NULL DEFAULT 0,
  -- The execution that claimed the current slice: every commit of a slice
  -- requires it, so a duplicate execution of one seq writes nothing.
  slice_token uuid,
  counters jsonb NOT NULL DEFAULT '{}',
  options jsonb NOT NULL,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  -- When a deferred slice is due back (a busy lease, a 429, a Retry-After):
  -- the stalled-run sweep counts it as a sign of life.
  resume_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT ticket_import_runs_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT ticket_import_runs_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_runs_window_fk FOREIGN KEY (window_id, partner_id)
    REFERENCES migration_windows(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_runs_kind_chk CHECK (kind IN ('dry_run', 'import')),
  CONSTRAINT ticket_import_runs_state_chk
    CHECK (state IN ('queued', 'running', 'completed', 'stopped', 'failed', 'cancelled')),
  CONSTRAINT ticket_import_runs_phase_chk CHECK (phase IN ('scan', 'links', 'deletions', 'done')),
  CONSTRAINT ticket_import_runs_window_chk CHECK ((kind = 'import') = (window_id IS NOT NULL)),
  CONSTRAINT ticket_import_runs_slice_seq_chk CHECK (slice_seq >= 0),
  -- A run is finished exactly when it is in a terminal state.
  CONSTRAINT ticket_import_runs_finished_chk
    CHECK ((state IN ('completed', 'stopped', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

-- One active run per source (spec §5.5); the route checks first, this is the
-- race-proof backstop.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_import_runs_one_active_per_source
  ON ticket_import_runs (source_id) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS ticket_import_runs_source_started_idx ON ticket_import_runs (source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ticket_import_runs_partner_idx ON ticket_import_runs (partner_id);
CREATE INDEX IF NOT EXISTS ticket_import_runs_window_idx ON ticket_import_runs (window_id) WHERE window_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_import_runs_started_by_idx ON ticket_import_runs (started_by);

CREATE TABLE IF NOT EXISTS ticket_import_items (
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_ticket_key varchar(255) NOT NULL,
  state text NOT NULL,
  imported_version varchar(64),
  seen_version varchar(64),
  seen_run_id uuid,
  -- The Breeze ticket this item imported into, or began to (a header written
  -- before a later transaction failed). FK-less: tickets are org data, and an
  -- erased org or a hard delete leaves the id behind, which is the point: an
  -- item that ever had a ticket is never imported again once its ref is gone
  -- (removed_in_breeze, spec §5.9).
  breeze_ticket_id uuid,
  -- Links the conversion asked for, waiting for the links phase (spec §6.6);
  -- NULL when none wait. Source keys, link types and times only.
  pending_links jsonb,
  failure_code varchar(64),
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_items_pkey PRIMARY KEY (source_id, source_ticket_key),
  CONSTRAINT ticket_import_items_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_items_state_chk CHECK (state IN (
    'imported', 'skipped', 'failed', 'deleted_in_source', 'hidden_in_source', 'removed_in_breeze', 'merged_in_breeze')),
  CONSTRAINT ticket_import_items_attempts_chk CHECK (attempts >= 0)
);

-- The deletions phase walks a source's imported items by key.
CREATE INDEX IF NOT EXISTS ticket_import_items_source_state_key_idx
  ON ticket_import_items (source_id, state, source_ticket_key);
CREATE INDEX IF NOT EXISTS ticket_import_items_partner_idx ON ticket_import_items (partner_id);

CREATE TABLE IF NOT EXISTS ticket_import_run_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_ticket_key varchar(255),
  source_ticket_number varchar(255),
  kind varchar(48) NOT NULL,
  code varchar(64),
  count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_run_issues_run_fk FOREIGN KEY (run_id, partner_id)
    REFERENCES ticket_import_runs(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_run_issues_count_chk CHECK (count >= 1)
);

CREATE INDEX IF NOT EXISTS ticket_import_run_issues_run_idx ON ticket_import_run_issues (run_id, kind, created_at, id);
-- One owner_unmatched row per distinct source owner per run (its code is the
-- source user key): the dedupe the run used to keep in its cursor.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_import_run_issues_owner_uq
  ON ticket_import_run_issues (run_id, code) WHERE kind = 'owner_unmatched';
CREATE INDEX IF NOT EXISTS ticket_import_run_issues_partner_idx ON ticket_import_run_issues (partner_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ticket_import_sources',
    'ticket_import_org_maps',
    'ticket_import_category_maps',
    'ticket_import_runs',
    'ticket_import_items',
    'ticket_import_run_issues'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_partner_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO breeze_app '
        'USING (public.breeze_current_scope() = ''system'' OR public.breeze_has_partner_access(partner_id)) '
        'WITH CHECK (public.breeze_current_scope() = ''system'' OR public.breeze_has_partner_access(partner_id))',
        t || '_partner_access', t
      );
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO breeze_app', t);
  END LOOP;
END $$;
