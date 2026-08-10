-- Partner-owned CIS baselines (epic #2135, Partner-Wide First).
--
-- Until now a cis_baselines row was always owned by exactly one org
-- (org_id NOT NULL), so an MSP could not define a CIS benchmark once — "CIS
-- Windows 11 L1, v3.0.0, scan every 24h" — and have it apply across every org
-- they manage. A CIS benchmark is an MSP standard, not customer data, so it is
-- exactly the shape the Partner-Wide First principle exists for. This migration
-- makes a baseline ownable by EITHER an org (org_id set, partner_id NULL — the
-- existing shape) OR a partner (partner_id set, org_id NULL — the
-- "partner-wide / all orgs" template shape), enforced by an exactly-one-axis
-- CHECK. Mirrors security_policies / software_policies
-- (2026-07-01-*-partner-ownership.sql) and configuration_policies (#1724).
--
-- NOT a leaf, unlike security_policies. Two child tables FK-reference it:
--   cis_baseline_results.baseline_id     ON DELETE CASCADE
--   cis_remediation_actions.baseline_id  ON DELETE SET NULL
-- Both children stay org_id NOT NULL and remain tenanted to the DEVICE's org,
-- never the baseline's. That is load-bearing: a partner-wide baseline has NO
-- org, so deriving a child's org from the baseline would write NULL into a
-- NOT NULL column. The application-side changes that guarantee this ship
-- alongside; this migration deliberately does not relax the children.
--
-- RLS: replaces the four legacy per-command breeze_org_isolation_* policies
-- (0048-cis-hardening.sql:127-139) with a single dual-axis policy + system
-- short-circuit, PLUS a SELECT-only branch letting an org-scoped user READ the
-- partner-wide baselines belonging to their own partner. That read branch is
-- deliberate: /cis/compliance and the device report INNER JOIN cis_baselines,
-- so without it an org admin's own compliance results would silently vanish
-- the moment their MSP moved a baseline partner-wide. Writes are unaffected —
-- permissive policies OR together, and the branch is FOR SELECT only.
-- Same mechanism as 2026-06-13-catalog-partner-read-branch.sql; kept as a
-- SEPARATE policy so the rls-coverage dual-axis assertion still sees a policy
-- whose predicate names breeze_has_partner_access for all four commands.
--
-- Agent contexts set currentPartnerId NULL (middleware/agentAuth.ts,
-- routes/agentWs.ts), so breeze_current_partner_id() is NULL there and the
-- read branch does NOT expose partner-wide rows to agents. The agent ingest
-- path resolves its baseline in a system context instead, on purpose.
--
-- No backfill: every existing row has org_id NOT NULL, so the XOR CHECK is
-- already satisfied the moment partner_id defaults to NULL. There is no
-- UPDATE/DELETE cleanup here, so the GET DIAGNOSTICS ROW_COUNT reporting rule
-- does not apply — nothing to report.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE public.cis_baselines
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE public.cis_baselines
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set. (org_id IS NULL) <> (partner_id IS NULL)
-- is true iff exactly one of the two is NULL — i.e. exactly one is set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cis_baselines_one_owner_chk'
      AND conrelid = 'public.cis_baselines'::regclass
  ) THEN
    ALTER TABLE public.cis_baselines
      ADD CONSTRAINT cis_baselines_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cis_baselines_partner_id_idx
  ON public.cis_baselines(partner_id);

-- Partner-axis counterpart of cis_baselines_org_os_idx: the scheduler and the
-- baseline list both filter partner-wide rows by os_type.
CREATE INDEX IF NOT EXISTS cis_baselines_partner_os_idx
  ON public.cis_baselines(partner_id, os_type);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================

ALTER TABLE public.cis_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cis_baselines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.cis_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.cis_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.cis_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.cis_baselines;
DROP POLICY IF EXISTS cis_baselines_isolation ON public.cis_baselines;
CREATE POLICY cis_baselines_isolation
  ON public.cis_baselines
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- Read-only widening: an ORG-scoped session may SELECT the partner-wide
-- baselines of its own partner. breeze_has_partner_access() is false for an
-- org token (it is flat partner-axis access, never tree traversal), so without
-- this branch the policy above hides partner-wide rows from org users — and
-- takes their INNER JOINed compliance results with them.
DROP POLICY IF EXISTS cis_baselines_partner_wide_select ON public.cis_baselines;
CREATE POLICY cis_baselines_partner_wide_select
  ON public.cis_baselines
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
