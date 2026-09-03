-- Portal report self-service (Wave W09).
--
-- report_schedule_recipients is deliberately organization-owned only (RLS
-- Shape 1). Recipient selection is per-customer delivery data, not reusable
-- partner-wide policy, so this is the Partner-Wide First exception approved by
-- the portal-visibility design.
--
-- public.breeze_has_org_access(org_id) contains the system-scope branch. The
-- policies below therefore admit the owning organization and trusted system
-- jobs without a separate, broader predicate.
--
-- Cascade-delete, tenant-export, and org-merge registration is deferred to
-- Task 9.2. No RLS allowlist entry is needed because Shape 1 is auto-discovered,
-- and there is no device cascade registration because there is no device_id.
--
-- requested_by_kind records who requested a run at write time. The matching
-- requester id may later become NULL through ON DELETE SET NULL; the provenance
-- CHECK therefore forbids only the wrong id and remains tombstone-compatible.
--
-- Idempotency: columns and indexes use IF NOT EXISTS, foreign keys are guarded
-- through pg_constraint, and policies are dropped before being recreated.

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS portal_self_service boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS reports_portal_self_service_org_type_uniq
  ON reports (org_id, type)
  WHERE portal_self_service = true;

-- Composite target required by report_schedule_recipients.
CREATE UNIQUE INDEX IF NOT EXISTS reports_id_org_id_uniq
  ON reports (id, org_id);

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS requested_by_kind text;

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS requested_by_user_id uuid;

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS requested_by_portal_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_runs_requested_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE report_runs
      ADD CONSTRAINT report_runs_requested_by_user_id_users_id_fk
      FOREIGN KEY (requested_by_user_id)
      REFERENCES users (id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'report_runs_requested_by_portal_user_id_portal_users_id_fk'
  ) THEN
    ALTER TABLE report_runs
      ADD CONSTRAINT
        report_runs_requested_by_portal_user_id_portal_users_id_fk
      FOREIGN KEY (requested_by_portal_user_id)
      REFERENCES portal_users (id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE report_runs
  DROP CONSTRAINT IF EXISTS report_runs_requested_by_shape_chk;

ALTER TABLE report_runs
  ADD CONSTRAINT report_runs_requested_by_shape_chk CHECK ((
    (
      requested_by_kind IS NULL
      AND requested_by_user_id IS NULL
      AND requested_by_portal_user_id IS NULL
    )
    OR (
      requested_by_kind = 'user'
      AND requested_by_portal_user_id IS NULL
    )
    OR (
      requested_by_kind = 'portal_user'
      AND requested_by_user_id IS NULL
    )
    OR (
      requested_by_kind = 'system'
      AND requested_by_user_id IS NULL
      AND requested_by_portal_user_id IS NULL
    )
  ) IS TRUE);

-- Fix forward from 2026-09-24-b-ai-agents-org-narrative.sql.
ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_execution_scope_principal_chk;

ALTER TABLE reports
  ADD CONSTRAINT reports_execution_scope_principal_chk CHECK (
    execution_scope_principal_kind IS NULL
    OR execution_scope_principal_kind IN (
      'user',
      'system',
      'portal_user'
    )
  );

ALTER TABLE report_runs
  DROP CONSTRAINT IF EXISTS report_runs_execution_scope_principal_chk;

ALTER TABLE report_runs
  ADD CONSTRAINT report_runs_execution_scope_principal_chk CHECK (
    execution_scope_principal_kind IS NULL
    OR execution_scope_principal_kind IN (
      'user',
      'system',
      'portal_user'
    )
  );

ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;

ALTER TABLE reports
  ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
      )
    )
  ) IS TRUE);

ALTER TABLE report_runs
  DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;

ALTER TABLE report_runs
  ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
      )
    )
  ) IS TRUE);

CREATE TABLE IF NOT EXISTS report_schedule_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  org_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_schedule_recipients_report_org_fk'
  ) THEN
    ALTER TABLE report_schedule_recipients
      ADD CONSTRAINT report_schedule_recipients_report_org_fk
      FOREIGN KEY (report_id, org_id)
      REFERENCES reports (id, org_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;

  ALTER TABLE report_schedule_recipients
    ALTER CONSTRAINT report_schedule_recipients_report_org_fk
    DEFERRABLE INITIALLY IMMEDIATE;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_schedule_recipients_contact_org_fk'
  ) THEN
    ALTER TABLE report_schedule_recipients
      ADD CONSTRAINT report_schedule_recipients_contact_org_fk
      FOREIGN KEY (contact_id, org_id)
      REFERENCES contacts (id, org_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;

  ALTER TABLE report_schedule_recipients
    ALTER CONSTRAINT report_schedule_recipients_contact_org_fk
    DEFERRABLE INITIALLY IMMEDIATE;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS
  report_schedule_recipients_report_contact_uniq
  ON report_schedule_recipients (report_id, contact_id);

CREATE INDEX IF NOT EXISTS report_schedule_recipients_org_idx
  ON report_schedule_recipients (org_id);

ALTER TABLE report_schedule_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedule_recipients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select
  ON report_schedule_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_insert
  ON report_schedule_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_update
  ON report_schedule_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_delete
  ON report_schedule_recipients;

CREATE POLICY breeze_org_isolation_select
  ON report_schedule_recipients
  FOR SELECT
  USING (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_insert
  ON report_schedule_recipients
  FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_update
  ON report_schedule_recipients
  FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_delete
  ON report_schedule_recipients
  FOR DELETE
  USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON report_schedule_recipients
  TO breeze_app;
