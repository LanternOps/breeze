-- Wisp W08a (#9914, feature #9906): soft links from a Wisp thread to the
-- Breeze objects it is about (Wisp design §6 / §17; w00 A35). The Wisp home,
-- the thread links panel, the session seed and the `link_entity` /
-- `list_links` chat tools read this table.
--
-- Tenancy — partner-anchored / org-optional, exactly the
-- connection_health_incidents (2026-12-29-100100) and wisp_concerns /
-- wisp_watches (2027-01-04-110300) shape: partner_id NOT NULL, org_id NULL
-- only for a partner-level link (entity_kind 'user', an org-less
-- 'organization', a partner-scoped 'run'/'task'), ONE FOR ALL policy
--   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
--          OR (org_id IS NULL AND breeze_has_partner_access(partner_id))
-- so every DML command is covered by both helpers (strict rls-coverage), and
-- NO breeze_current_partner_id() read branch: an org token must never see a
-- partner-level link. Registered in DUAL_AXIS_TENANT_TABLES,
-- CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry.ts (`repoint`) and
-- CORE_TENANT_EXPORT_POLICY: org rows carry org_id, and the cascade's
-- `WHERE org_id = $1` never touches partner-level rows (those leave with the
-- thread / partner via ON DELETE CASCADE). A merge repoint cannot collide on
-- the (thread_id, entity_kind, entity_id) unique: org_id is not in it.
--
-- entity_id is a SOFT reference (no FK): links span ten target tables with
-- conflicting erasure dispositions; a deleted entity resolves to null on read
-- and the row is pruned there. label is a display cache, never an authority.
-- The column is named entity_id (not device_id/ticket_id) so the device/ticket
-- cascade-list coverage tests do not match it — those lists are untouched.
--
-- Every reference is composite with partner_id so a link can never point
-- across partners: thread (thread_id, partner_id) -> wisp_threads,
-- org (org_id, partner_id) -> organizations, added-by user
-- (added_by_user_id, partner_id) -> users (users_id_partner_id_key ships from
-- 2027-01-04-100100-wisp-grants.sql), added-by grant
-- (added_by_grant_id, partner_id) -> wisp_grants with the PG 15+ column-list
-- ON DELETE SET NULL (added_by_grant_id) — a plain SET NULL would null
-- partner_id too and fail NOT NULL.
--
-- Composite FKs whose target includes an org_id column are DEFERRABLE
-- INITIALLY IMMEDIATE (org merge defers constraints). entity_kind is text +
-- CHECK; its list is mirrored by WISP_ENTITY_KINDS in packages/shared
-- (types/wisp.ts) — change both together. The thread/entity unique index is
-- NULLS NOT DISTINCT (PG 15+; the stack runs pgvector/pgvector:pg16).
--
-- DDL only — writes no rows, so no breeze.scope election (set_config) is
-- needed. Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

CREATE TABLE IF NOT EXISTS wisp_thread_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         uuid NOT NULL,
  partner_id        uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL = a partner-level link, visible to partner-scoped sessions only.
  org_id            uuid NULL,
  entity_kind       text NOT NULL,
  -- Soft reference: no FK.
  entity_id         uuid NOT NULL,
  -- Display cache, never an authority.
  label             text NOT NULL,
  added_by_user_id  uuid NOT NULL,
  -- Set when the `link_entity` chat tool added it.
  added_by_grant_id uuid NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_links_entity_kind_chk') THEN
    ALTER TABLE wisp_thread_links
      ADD CONSTRAINT wisp_thread_links_entity_kind_chk
      CHECK (entity_kind IN ('ticket','quote','invoice','contract','device','organization','site','alert','run','task','user'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_links_label_len_chk') THEN
    ALTER TABLE wisp_thread_links
      ADD CONSTRAINT wisp_thread_links_label_len_chk
      CHECK (char_length(label) <= 200);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_links_thread_fk') THEN
    ALTER TABLE wisp_thread_links
      ADD CONSTRAINT wisp_thread_links_thread_fk
      FOREIGN KEY (thread_id, partner_id) REFERENCES wisp_threads (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_links_org_partner_fk') THEN
    ALTER TABLE wisp_thread_links
      ADD CONSTRAINT wisp_thread_links_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_links_added_by_user_fk') THEN
    ALTER TABLE wisp_thread_links
      ADD CONSTRAINT wisp_thread_links_added_by_user_fk
      FOREIGN KEY (added_by_user_id, partner_id) REFERENCES users (id, partner_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_links_added_by_grant_fk') THEN
    ALTER TABLE wisp_thread_links
      ADD CONSTRAINT wisp_thread_links_added_by_grant_fk
      FOREIGN KEY (added_by_grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
      ON DELETE SET NULL (added_by_grant_id);
  END IF;
END $$;

-- One link per object per thread; NULLS NOT DISTINCT (no column is nullable
-- today — kept so a future nullable key cannot silently admit duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS wisp_thread_links_thread_entity_uq
  ON wisp_thread_links (thread_id, entity_kind, entity_id) NULLS NOT DISTINCT;
-- The thread's links panel / session seed, newest first.
CREATE INDEX IF NOT EXISTS wisp_thread_links_thread_created_idx ON wisp_thread_links (thread_id, created_at DESC);
-- Org cascade / org merge reach the org rows by org_id.
CREATE INDEX IF NOT EXISTS wisp_thread_links_org_idx ON wisp_thread_links (org_id) WHERE org_id IS NOT NULL;
-- The per-object "linked in Wisp" badge.
CREATE INDEX IF NOT EXISTS wisp_thread_links_entity_idx ON wisp_thread_links (entity_kind, entity_id);
-- Partner erasure and the partner-axis RLS branch.
CREATE INDEX IF NOT EXISTS wisp_thread_links_partner_idx ON wisp_thread_links (partner_id);
-- The added-by FKs' cascade / SET NULL scans on user and grant erasure.
CREATE INDEX IF NOT EXISTS wisp_thread_links_added_by_user_idx ON wisp_thread_links (added_by_user_id);
CREATE INDEX IF NOT EXISTS wisp_thread_links_added_by_grant_idx
  ON wisp_thread_links (added_by_grant_id) WHERE added_by_grant_id IS NOT NULL;

-- RLS — ENABLE + FORCE in the creating file; one FOR ALL policy.
ALTER TABLE wisp_thread_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_thread_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wisp_thread_links_isolation ON wisp_thread_links;
CREATE POLICY wisp_thread_links_isolation ON wisp_thread_links
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

-- The API connects as the unprivileged app role; DELETE is needed by the org
-- cascade, partner erasure and the read-time prune; UPDATE by org merge.
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_thread_links TO breeze_app;
