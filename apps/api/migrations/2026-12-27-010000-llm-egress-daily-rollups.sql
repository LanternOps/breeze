-- #4120: daily rollups that raw llm_egress_events rows are folded into by the
-- retention job (jobs/llmEgressRetention.ts).
--
-- Policy (owner decision on #4120): keep raw per-request egress rows for
-- LLM_EGRESS_EVENTS_RETENTION_DAYS (default 90), then keep one row per
-- (org, UTC day, surface, host) until org erasure. The job folds and deletes
-- in ONE statement (DELETE ... RETURNING feeding INSERT ... ON CONFLICT DO
-- UPDATE that ADDS counts), so a raw row is never deleted without being
-- counted and never counted twice.
--
-- Grain: request_count / blocked_count are columns, not a `blocked` dimension.
-- No CHECK on `surface`: rows only ever derive from llm_egress_events, whose
-- llm_egress_events_surface_chk already enforces the vocabulary; a third
-- hand-mirrored copy would be one more place to forget on a new surface.
--
-- Tenancy: RLS shape 1 (direct org_id), same as the raw table. org_id is NOT
-- NULL because this is per-org telemetry derived from an org-scoped table.
-- Dual-axis composite FK to organizations(id, partner_id), DEFERRABLE
-- INITIALLY IMMEDIATE per the org-merge contract (docs/agents/tenancy-rls.md).
--
-- breeze_app keeps UPDATE (unlike llm_egress_events): the fold runs as
-- breeze_app and rewrites the counters of an existing day by design. Accepted
-- trade-off: the summary is less tamper-resistant than the raw audit rows it
-- replaces; only the system-scoped retention job writes it.
--
-- DDL only: no row writes, so no breeze.scope=system election is needed.
-- Idempotent: IF NOT EXISTS everywhere; the policy is dropped and re-created.

CREATE TABLE IF NOT EXISTS public.llm_egress_daily_rollups (
  org_id         uuid NOT NULL,
  partner_id     uuid NOT NULL,
  day            date NOT NULL,
  surface        text NOT NULL,
  host           text NOT NULL,
  request_count  bigint NOT NULL DEFAULT 0,
  blocked_count  bigint NOT NULL DEFAULT 0,
  first_event_at timestamptz NOT NULL,
  last_event_at  timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_egress_daily_rollups_pkey PRIMARY KEY (org_id, day, surface, host),
  CONSTRAINT llm_egress_daily_rollups_counts_chk
    CHECK (request_count >= 0 AND blocked_count >= 0 AND blocked_count <= request_count),
  CONSTRAINT llm_egress_daily_rollups_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS llm_egress_daily_rollups_partner_idx
  ON public.llm_egress_daily_rollups (partner_id, day);

-- The fold selects `WHERE created_at < cutoff LIMIT n` across all orgs; the
-- raw table's only time indexes lead with org_id / partner_id, so without this
-- every batch (and every night's final short batch) is a full heap scan. BRIN
-- because the table is insert-ordered by created_at and never UPDATEd; same
-- choice as 2026-07-29-timeseries-retention-brin.sql (migration-only, not in
-- the Drizzle schema, matching that precedent). Prod row count is 0 today, so
-- a plain (non-CONCURRENTLY) build is instant.
CREATE INDEX IF NOT EXISTS llm_egress_events_created_at_brin_idx
  ON public.llm_egress_events USING brin (created_at);

ALTER TABLE public.llm_egress_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_egress_daily_rollups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS llm_egress_daily_rollups_isolation ON public.llm_egress_daily_rollups;
CREATE POLICY llm_egress_daily_rollups_isolation ON public.llm_egress_daily_rollups
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.llm_egress_daily_rollups TO breeze_app;
  END IF;
END $$;
