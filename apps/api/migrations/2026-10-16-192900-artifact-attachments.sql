-- Execution plane W05: attach an AI run artifact to a ticket or a report run
-- BY REFERENCE, without copying bytes.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md §6.3
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file in a
-- transaction). DDL only — no row writes, so no breeze.scope elevation is
-- needed (see CLAUDE.md's migration rules for when it IS).
--
-- ON DELETE SET NULL on both, deliberately: artifacts expire after 30 days and
-- the sweeper deletes them. A ticket that outlives its artifact must degrade to
-- "this file has expired" (HTTP 410), never to a row pointing at a blob that is
-- gone, and never to a ticket that cannot be deleted because a retention
-- sweeper holds a reference to it.

-- ── ticket_attachments ──────────────────────────────────────────────────────
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS artifact_id uuid;

DO $$ BEGIN
  ALTER TABLE ticket_attachments
    ADD CONSTRAINT ticket_attachments_artifact_id_ai_run_artifacts_id_fk
    FOREIGN KEY (artifact_id) REFERENCES ai_run_artifacts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The shipped backend CHECK admits only 's3' and 'db'. A third backend,
-- 'artifact', stores neither a key nor bytes of its own: the row is a POINTER
-- to an ai_run_artifacts row that owns the blob. Dropped and re-added rather
-- than amended, because a CHECK cannot be altered in place.
--
-- The artifact arm does NOT require artifact_id IS NOT NULL. It must survive
-- the ON DELETE SET NULL above: when the artifact expires the row stays, with
-- a null pointer, and the content route answers 410. A NOT NULL arm here would
-- make the sweeper's DELETE fail with 23514 and wedge artifact retention.
ALTER TABLE ticket_attachments DROP CONSTRAINT IF EXISTS ticket_attachments_backend_chk;
ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_backend_chk CHECK (
  (storage_backend = 's3'       AND storage_key IS NOT NULL AND data IS NULL       AND artifact_id IS NULL) OR
  (storage_backend = 'db'       AND data IS NOT NULL        AND storage_key IS NULL AND artifact_id IS NULL) OR
  (storage_backend = 'artifact' AND data IS NULL            AND storage_key IS NULL));

-- The 10 MiB ceiling exists because an uploaded attachment transits the API and
-- lands in this table's own bytea or object. An artifact reference copies
-- nothing, so it is bounded by the run's artifact cap
-- (analysisMaxArtifactBytesPerRun, <= 512 MiB; 128 MiB by default) instead.
-- 134217728 = 128 MiB, the default cap — raise this only alongside that default.
ALTER TABLE ticket_attachments DROP CONSTRAINT IF EXISTS ticket_attachments_size_chk;
ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_size_chk CHECK (
  byte_size > 0 AND byte_size <= (CASE WHEN storage_backend = 'artifact' THEN 134217728 ELSE 10485760 END));

-- Partial: almost no attachment is artifact-backed, and the sweeper's
-- SET NULL needs to find the referencing rows quickly.
CREATE INDEX IF NOT EXISTS ticket_attachments_artifact_idx
  ON ticket_attachments (artifact_id) WHERE artifact_id IS NOT NULL;

-- ── report_runs ─────────────────────────────────────────────────────────────
-- report_runs has no org_id of its own (tenancy is reports.org_id), so it is in
-- neither CORE_ORG_CASCADE_DELETE_ORDER nor CORE_TENANT_EXPORT_POLICY and needs
-- no registration for this column. Its erasure path is the explicit pre-clear
-- in services/tenantCascade.ts.
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS artifact_id uuid;

DO $$ BEGIN
  ALTER TABLE report_runs
    ADD CONSTRAINT report_runs_artifact_id_ai_run_artifacts_id_fk
    FOREIGN KEY (artifact_id) REFERENCES ai_run_artifacts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS report_runs_artifact_idx
  ON report_runs (artifact_id) WHERE artifact_id IS NOT NULL;
