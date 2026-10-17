-- apps/api/migrations/2026-12-30-120500-trust-page-templates.sql
-- Trust Center W2, sub-wave W02g (#8770, spec trust-center/2026-10-12 §18.8, §19 item 33):
-- the partner-wide trust page template. One row per partner holds the partner's default for every
-- inheritable trust page setting; NULL in a column means "not set here" and the setting falls through
-- to the built-in default (resolveEffectiveTrustSettings in @breeze/shared: page → template → default).
-- An org page's own non-null value wins over the template. Publish freezes the resolved values into
-- trust_pages.published_config, so a template edit never changes an already-published page until it
-- is republished.
--
-- TENANCY: RLS shape 3 (partner-axis), copied from 2026-10-21-100000-work-types.sql: one FOR ALL TO
-- breeze_app policy, breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id), on
-- both USING and WITH CHECK.
--
-- partner_id NOT NULL is the product owner's decision (spec §18.8, plan amendment 33): a template is
-- the partner's own default for its customers' pages, never an org-owned policy, so Partner-Wide
-- First's org-XOR-partner shape has nothing to choose between. Deliberately NO org_id, so the only
-- registration this table owes is PARTNER_TENANT_TABLES in rls-coverage.integration.test.ts. No
-- CORE_ORG_CASCADE_DELETE_ORDER, no CORE_TENANT_EXPORT_POLICY, no orgMergeRegistry entry (an org
-- merge never moves a partner's template). Not in DUAL_AXIS_TENANT_TABLES or
-- PARTNER_WIDE_SELECT_BRANCH_EXEMPT.
--
-- PARTNER ERASURE: cascadeDeletePartner discovers this table from its partner_id column
-- (information_schema sweep) and topologicalCascadeOrder's pg_constraint read orders it before
-- `partners`. The DELETE grant below is what makes that sweep work. The partner FK carries no
-- ON DELETE, matching the other partner-axis tables: the sweep deletes these rows explicitly.
--
-- `revision` is bumped by every write (services/trustPage/template.ts). The org editor loads it with
-- the page and sends it back on publish as expectedTemplateRevision; a mismatch is 409
-- TEMPLATE_CHANGED, so a publisher never freezes inherited values they did not see.
--
-- DDL only: no rows written, so no breeze.scope election is required
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps
-- the file).

CREATE TABLE IF NOT EXISTS trust_page_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id          uuid NOT NULL REFERENCES partners(id),
  intro_html          text NULL,
  search_indexable    boolean NULL,
  show_percentages    boolean NULL,
  show_device_count   boolean NULL,
  show_managed_by     boolean NULL,
  show_history        boolean NULL,
  hidden_control_ids  text[] NULL,
  framework_view      text[] NULL,
  revision            integer NOT NULL DEFAULT 0,
  updated_by_user_id  uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Same stored bound as trust_pages.intro_html (TRUST_INTRO_STORED_MAX_CHARS): sanitized HTML only.
  CONSTRAINT trust_page_templates_intro_len_chk CHECK (intro_html IS NULL OR length(intro_html) <= 40000),
  CONSTRAINT trust_page_templates_revision_chk CHECK (revision >= 0)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trust_page_templates_partner_uq'
  ) THEN
    ALTER TABLE trust_page_templates ADD CONSTRAINT trust_page_templates_partner_uq UNIQUE (partner_id);
  END IF;
END $$;

ALTER TABLE trust_page_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_templates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trust_page_templates'
      AND policyname = 'trust_page_templates_partner_access'
  ) THEN
    CREATE POLICY trust_page_templates_partner_access ON trust_page_templates
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard DELETEs as breeze_app
-- under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON trust_page_templates TO breeze_app;
