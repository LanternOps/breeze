-- Connection health incidents (spec 2026-10-15 §2.1). Dual-axis (shape 4):
-- partner_id NOT NULL, org_id NULL only for partner-owned connections.
-- Written only by the reconciler in system scope; the API route is GET-only.
SELECT set_config('breeze.scope', 'system', true);

CREATE TABLE IF NOT EXISTS public.connection_health_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  org_id            uuid NULL,
  owner_user_id     uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  source_kind       text NOT NULL,
  source_id         text NOT NULL,
  condition         text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('permanent','transient')),
  detail            text NULL CHECK (char_length(detail) <= 300),
  display_name      text NOT NULL CHECK (char_length(display_name) <= 120),
  fix_href          text NOT NULL CHECK (fix_href LIKE '/%' AND fix_href NOT LIKE '//%'),
  owner_fix_href    text NULL CHECK (owner_fix_href IS NULL OR (owner_fix_href LIKE '/%' AND owner_fix_href NOT LIKE '//%')),
  view_permission   text NOT NULL,
  repair_permission text NOT NULL,
  first_failed_at   timestamptz NOT NULL,
  opened_at         timestamptz NULL,
  last_observed_at  timestamptz NOT NULL,
  healthy_streak    smallint NOT NULL DEFAULT 0,
  flap_count        integer NOT NULL DEFAULT 0,
  resolved_at       timestamptz NULL,
  resolution        text NULL CHECK (resolution IN ('recovered','retired')),
  pending_notice    text NULL CHECK (pending_notice IN ('opened','escalated','resolved')),
  notified_user_ids uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT connection_health_incidents_resolution_chk
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_health_incidents_org_partner_fk') THEN
    ALTER TABLE public.connection_health_incidents
      ADD CONSTRAINT connection_health_incidents_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations(id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS connection_health_incidents_open_uniq
  ON public.connection_health_incidents (source_kind, source_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_partner_open_idx
  ON public.connection_health_incidents (partner_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_kind_resolved_idx
  ON public.connection_health_incidents (source_kind, resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_pending_notice_idx
  ON public.connection_health_incidents (id) WHERE pending_notice IS NOT NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_org_idx
  ON public.connection_health_incidents (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE public.connection_health_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_health_incidents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connection_health_incidents_isolation ON public.connection_health_incidents;
CREATE POLICY connection_health_incidents_isolation ON public.connection_health_incidents
  FOR ALL
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

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_health_incidents TO breeze_app;
  END IF;
END $$;

-- OAuth source (W1): grants revoked automatically for refresh-token reuse.
-- Keeps the broken-set query index-backed (spec §1.3) as oauth_grants grows.
-- provider-revoke-grant is excluded: deliberate RP revocation writes it too.
CREATE INDEX IF NOT EXISTS oauth_grants_auto_revoked_idx
  ON public.oauth_grants (revoked_at)
  WHERE revoked_reason = 'refresh-token-reuse' AND revoked_by_user_id IS NULL;
