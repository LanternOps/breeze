-- Chunked software-package upload sessions (issue #2951).
--
-- One row per in-flight dashboard upload. Chunks are appended to temp_path on
-- the API host's local filesystem; the row tracks bytes_received so an
-- interrupted upload can resume and duplicate chunks are idempotent. Rows are
-- deleted at complete/abort; the softwareUploadSessionCleanup BullMQ job reaps
-- sessions idle >2h OR older than 24h absolute (both env-tunable).
--
-- owner_instance_id pins each session to the API process that owns its temp
-- file: chunk/complete requests reaching a different process answer a
-- non-retryable 409 'upload_instance_mismatch' (multi-replica tripwire).
--
-- Tenancy: Shape 1 (direct org_id), auto-discovered by the RLS coverage
-- contract test — no allowlist entry. RLS is enabled AND forced with all four
-- breeze_has_org_access(org_id) policies in this same migration (never
-- deferred).
--
-- FK direction (deliberate): catalog_id -> software_catalog ON DELETE CASCADE,
-- org_id -> organizations ON DELETE CASCADE. These guard a direct DELETE on
-- either parent outside the org-erasure path. They are NOT required by the org
-- cascade itself: deleteOrgCascade calls topologicalCascadeOrder(), which
-- recomputes an FK-safe order from the live pg_constraint catalog, so this
-- table is always deleted before both parents no matter where it sits
-- alphabetically in CORE_ORG_CASCADE_DELETE_ORDER. created_by -> users ON
-- DELETE SET NULL: a deleted user must not strand an in-flight upload row
-- behind an FK error.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO block for constraints,
-- CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE POLICY.

CREATE TABLE IF NOT EXISTS software_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  catalog_id uuid NOT NULL REFERENCES software_catalog(id) ON DELETE CASCADE,
  file_name varchar(500) NOT NULL,
  file_size bigint NOT NULL,
  chunk_size integer NOT NULL,
  bytes_received bigint NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active',
  temp_path text NOT NULL,
  owner_instance_id varchar(64) NOT NULL,
  version_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_upload_sessions_status_chk') THEN
    ALTER TABLE software_upload_sessions
      ADD CONSTRAINT software_upload_sessions_status_chk
      CHECK (status IN ('active', 'completed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_upload_sessions_size_chk') THEN
    ALTER TABLE software_upload_sessions
      ADD CONSTRAINT software_upload_sessions_size_chk
      CHECK (file_size > 0 AND bytes_received >= 0 AND bytes_received <= file_size);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_upload_sessions_org_id_idx
  ON software_upload_sessions(org_id);
CREATE INDEX IF NOT EXISTS software_upload_sessions_catalog_id_idx
  ON software_upload_sessions(catalog_id);
-- Reaper scan: stale-session sweep filters on last_activity_at.
CREATE INDEX IF NOT EXISTS software_upload_sessions_last_activity_idx
  ON software_upload_sessions(last_activity_at);

-- RLS: direct org_id (Shape 1) — standard org isolation, enabled AND forced.
ALTER TABLE software_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_upload_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_upload_sessions;

CREATE POLICY breeze_org_isolation_select ON software_upload_sessions FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON software_upload_sessions FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON software_upload_sessions FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON software_upload_sessions FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON software_upload_sessions TO breeze_app;
