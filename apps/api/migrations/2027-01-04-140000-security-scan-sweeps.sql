-- #6263 W05 (#6268) — IOC sweeps.
--
-- security_scan_sweeps: one row per org touched by a sweep request (the rows of
-- one request share group_id). It pins the rule-set versions approved at
-- create; its children are ordinary security_scans rows carrying sweep_id.
--
-- Tenancy shape 1 (org_id NOT NULL). An execution record like
-- script_execution_batches / patch_jobs, not a config or policy table, so
-- Partner-Wide First does not apply: a cross-org request is N org rows.
--
-- security_scans.sweep_id is a PLAIN FK, not a composite (sweep_id, org_id):
-- the device-org move restamps security_scans.org_id while the sweep stays in
-- the source org, and the mover detaches the device's sweep scans before the
-- restamp (moveDeviceOrgInTransaction.ts). Readers also require
-- sweep.org_id = scan.org_id.
--
-- Writes no rows, so no breeze.scope election is needed.

CREATE TABLE IF NOT EXISTS public.security_scan_sweeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  -- Shared by the org rows of one request; no FK.
  group_id uuid NOT NULL,
  -- sha256 hex of { orgId, pins id@sha256, scanType, paths } (dedupe of re-clicks).
  dedupe_key varchar(64) NOT NULL,
  -- Sorted, distinct, 1..20.
  rule_set_ids uuid[] NOT NULL,
  -- [{ id, version, sha256 }] pinned at create.
  rule_set_pins jsonb NOT NULL,
  scan_type varchar(16) NOT NULL,
  paths text[] NULL,
  -- The request scope, for display.
  scope jsonb NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'active',
  targeted_count integer NOT NULL,
  -- { agent_too_old, busy_same_sweep, rule_set_not_eligible } counts.
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  origin varchar(16) NOT NULL,
  -- AiOriginRef when origin is ai_chat | mcp.
  ai_origin jsonb NULL,
  -- action_intents.id; no FK.
  intent_id uuid NULL,
  created_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT security_scan_sweeps_state_chk
    CHECK (state IN ('active', 'completed', 'cancelled', 'expired')),
  CONSTRAINT security_scan_sweeps_scan_type_chk
    CHECK (scan_type IN ('quick', 'full', 'custom')),
  CONSTRAINT security_scan_sweeps_rule_sets_chk
    CHECK (cardinality(rule_set_ids) BETWEEN 1 AND 20),
  CONSTRAINT security_scan_sweeps_paths_chk
    CHECK ((scan_type = 'custom') = (paths IS NOT NULL AND cardinality(paths) BETWEEN 1 AND 20)),
  CONSTRAINT security_scan_sweeps_origin_chk
    CHECK (origin IN ('web', 'api', 'ai_chat', 'mcp'))
);

CREATE INDEX IF NOT EXISTS security_scan_sweeps_org_created_idx
  ON public.security_scan_sweeps (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_scan_sweeps_group_idx
  ON public.security_scan_sweeps (group_id);
CREATE INDEX IF NOT EXISTS security_scan_sweeps_active_expires_idx
  ON public.security_scan_sweeps (expires_at)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS security_scan_sweeps_active_dedupe_idx
  ON public.security_scan_sweeps (org_id, dedupe_key)
  WHERE state = 'active';

ALTER TABLE public.security_scan_sweeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_scan_sweeps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.security_scan_sweeps;
CREATE POLICY breeze_org_isolation_select ON public.security_scan_sweeps FOR SELECT
  USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.security_scan_sweeps;
CREATE POLICY breeze_org_isolation_insert ON public.security_scan_sweeps FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.security_scan_sweeps;
CREATE POLICY breeze_org_isolation_update ON public.security_scan_sweeps FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.security_scan_sweeps;
CREATE POLICY breeze_org_isolation_delete ON public.security_scan_sweeps FOR DELETE
  USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.security_scan_sweeps TO breeze_app;
REVOKE TRUNCATE ON public.security_scan_sweeps FROM breeze_app;

-- The sweep a scan belongs to (NULL for scheduled and manual scans).
ALTER TABLE public.security_scans
  ADD COLUMN IF NOT EXISTS sweep_id uuid NULL
  REFERENCES public.security_scan_sweeps(id) ON DELETE SET NULL;
-- [{ id, version, sha256 }] actually sent to the agent; the fetch route
-- authorizes these exact refs for a running scan.
ALTER TABLE public.security_scans ADD COLUMN IF NOT EXISTS dispatched_rule_sets jsonb NULL;
-- device_commands.id of the dispatch; no FK (commands are pruned on their own clock).
ALTER TABLE public.security_scans ADD COLUMN IF NOT EXISTS command_id uuid NULL;

CREATE INDEX IF NOT EXISTS security_scans_sweep_status_idx
  ON public.security_scans (sweep_id, status)
  WHERE sweep_id IS NOT NULL;
